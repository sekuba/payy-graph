import { all, type Db, getSync, one } from '../db'
import { type ChainId, labelOf, TxKind } from '../protocol'
import { type Bounds, inferAmounts } from './amounts'
import {
  collect,
  getNote,
  getTxn,
  type NoteRow,
  type Subgraph,
  type TxnRow,
  withSideBranches,
} from './closure'
import { cardBatch, migrationSummary, Role } from './roles'
import { flowInto } from './sources'
import type {
  AddressSummary,
  CardBatch,
  Deposit,
  Graph,
  Resolved,
  Status,
  Withdrawal,
} from './types'

/** Default cap on transactions loaded for one graph view */
export const DEFAULT_LIMIT = 400

interface DepositRow {
  mint_hash: string
  chain: ChainId
  tx: string
  time: number
  depositor: string
  amount: number
}

interface BurnedRow {
  tx: string
  substitute: number
}

/**
 * Deposit behind a mint transaction, if the L1 side is indexed. The deposit
 * that counts is the one on the chain that settled the mint's height.
 */
export function depositOf(db: Db, mint: TxnRow): Deposit | undefined {
  const chain = settlementChain(db, mint.height)
  const row = one<DepositRow>(
    db,
    `select * from deposit where mint_hash = ?
     order by (chain = ?) desc, block limit 1`,
    mint.msg_hash,
    chain ?? '',
  )
  if (!row) return undefined
  return {
    mintHash: row.mint_hash,
    txHash: mint.hash,
    chain: row.chain,
    l1Tx: row.tx,
    time: row.time,
    depositor: row.depositor,
    label: labelOf(row.depositor),
    amount: row.amount,
  }
}

/**
 * The chain whose state update covered a Payy height: the first settlement
 * at or after it. Burns are paid out on that chain, whatever else carries
 * the same burn hash (the substitutor can front a burn with any hash).
 */
export function settlementChain(db: Db, height: number): ChainId | undefined {
  return one<{ chain: ChainId }>(
    db,
    'select chain from settlement where height >= ? order by height limit 1',
    height,
  )?.chain
}

/**
 * Withdrawal described by a burn transaction. The recipient and amount come
 * from the proof's public inputs; the L1 events tell how and when it was
 * paid. A fronted withdrawal has two Burned events: the substitutor paying
 * the user early, and the settlement refunding the substitutor.
 */
export function withdrawalOf(db: Db, burn: TxnRow): Withdrawal {
  const chain = settlementChain(db, burn.height)
  const events = all<BurnedRow>(
    db,
    'select * from burned where burn_hash = ? and chain = ? order by block, log_index',
    burn.msg_hash,
    chain ?? '',
  )
  const fronted = events.find((e) => e.substitute === 1)
  const settled = events.find((e) => e.substitute === 0)
  const recipient = burn.burn_addr ?? ''
  return {
    burnHash: burn.msg_hash,
    txHash: burn.hash,
    recipient,
    label: labelOf(recipient),
    amount: burn.amount,
    time: burn.time,
    chain: events.length > 0 ? chain : undefined,
    paidTx: (fronted ?? settled)?.tx,
    settledTx: settled?.tx,
    substituted: fronted !== undefined,
  }
}

/** A card batch by its burn tx, with how it was paid out on L1 */
export function cardBatchOf(db: Db, burnTx: string): CardBatch | undefined {
  const row = cardBatch(db, burnTx)
  const burn = getTxn(db, burnTx)
  if (!row || !burn) return undefined
  const w = withdrawalOf(db, burn)
  return {
    burnTx,
    time: row.time,
    firstTime: row.first_time,
    amount: row.amount,
    notes: row.notes,
    recipient: w.recipient,
    chain: w.chain,
    paidTx: w.paidTx,
  }
}

/**
 * Amount inference over a subgraph and the card batches its notes were
 * paid into. A batch adds one equation: the notes merged into it sum to the
 * amount it withdrew. Merged notes from outside the subgraph are one
 * unknown, so a payment is at most the batch total, and exactly it when the
 * batch holds nothing else.
 */
export function inferWithBatches(
  db: Db,
  sub: Pick<Subgraph, 'txns' | 'notes' | 'boundaries'>,
): Map<string, Bounds> {
  const txns = new Map(sub.txns)
  const notes = new Map(sub.notes)
  const paid = new Map<string, NoteRow[]>()
  for (const n of sub.notes.values()) {
    const role = n.spent_tx ? sub.boundaries.get(n.spent_tx) : undefined
    if (role?.role !== Role.Card) continue
    const list = paid.get(role.batch) ?? []
    list.push(n)
    paid.set(role.batch, list)
  }
  for (const [burnTx, payments] of paid) {
    const batch = cardBatch(db, burnTx)
    if (!batch) continue
    const id = `batch:${burnTx}`
    txns.set(id, {
      hash: id,
      height: batch.height,
      idx: 0,
      time: batch.time,
      kind: TxKind.Burn,
      amount: batch.amount,
      msg_hash: '',
      burn_addr: null,
    })
    for (const n of payments) notes.set(n.commitment, { ...n, spent_tx: id })
    if (batch.notes > payments.length) {
      const rest = `rest:${burnTx}`
      notes.set(rest, {
        commitment: rest,
        created_tx: null,
        created_idx: null,
        spent_tx: id,
        spent_idx: null,
      })
    }
  }
  return inferAmounts({ txns, notes })
}

/**
 * The graph around one or more transactions. Backward reaches the deposits
 * that funded them, forward the withdrawals they funded. Seen back from
 * withdrawals, it also tells how much of them can have come from each
 * deposit, and how much of each note can end up in them.
 */
export function graphAround(
  db: Db,
  txHashes: string[],
  direction: { backward: boolean; forward: boolean },
  limit = DEFAULT_LIMIT,
): Graph {
  const sub = collect(db, txHashes, direction, limit)
  const bounds = inferWithBatches(db, withSideBranches(db, sub))
  const burns = txHashes.filter((h) => sub.txns.get(h)?.kind === TxKind.Burn)
  const flow =
    !direction.forward && burns.length > 0 && burns.length === txHashes.length
      ? flowInto(sub, bounds, burns)
      : undefined
  const deposits: Deposit[] = []
  const withdrawals: Withdrawal[] = []
  for (const t of sub.txns.values()) {
    const hops = sub.hops.get(t.hash)
    if (t.kind === TxKind.Mint) {
      const d = depositOf(db, t)
      if (d) deposits.push({ ...d, hops, share: flow?.shares.get(t.hash) })
    }
    if (t.kind === TxKind.Burn) {
      const reach = burns.includes(t.hash) ? undefined : flow?.txns.get(t.hash)
      withdrawals.push({ ...withdrawalOf(db, t), hops, reach })
    }
  }
  const roles = new Set([...sub.boundaries.values()].map((r) => r.role))
  const batches = new Set(
    [...sub.boundaries.values()]
      .filter((r) => r.role === Role.Card)
      .map((r) => r.batch),
  )
  // nearest first: the deposits few hops away are the ones that matter
  const nearestFirst = (a: { hops?: number; time: number }, b: typeof a) =>
    (a.hops ?? 0) - (b.hops ?? 0) || a.time - b.time
  // unless their share is known: then the largest first
  return {
    txns: [...sub.txns.values()]
      .sort((a, b) => a.height - b.height || a.idx - b.idx)
      .map((t) => ({
        hash: t.hash,
        height: t.height,
        time: t.time,
        kind: t.kind,
        amount: t.amount,
        reach: flow?.txns.get(t.hash),
      })),
    notes: [...sub.notes.values()].map((n) => {
      const source = n.created_tx ? sub.boundaries.get(n.created_tx) : undefined
      const sink = n.spent_tx ? sub.boundaries.get(n.spent_tx) : undefined
      return {
        commitment: n.commitment,
        from: n.created_tx ?? undefined,
        to: n.spent_tx ?? undefined,
        continues: n.spent_tx !== null && !sub.txns.has(n.spent_tx),
        ...(source?.role === Role.Migration && {
          source: 'migration' as const,
        }),
        ...(sink?.role === Role.Card && { batch: sink.batch }),
        ...(bounds.get(n.commitment) ?? { min: 0 }),
        ...(flow && { reach: flow.notes.get(n.commitment) ?? 0 }),
      }
    }),
    deposits: deposits.sort((a, b) =>
      flow ? bySize(a, b) || nearestFirst(a, b) : nearestFirst(a, b),
    ),
    withdrawals: withdrawals.sort(nearestFirst),
    migration: roles.has(Role.Migration) ? migrationSummary(db) : undefined,
    batches: [...batches].flatMap((b) => cardBatchOf(db, b) ?? []),
    truncated: sub.truncated,
  }
}

/** Deposits with the largest share first: by its upper, then lower bound */
export function bySize(a: Deposit, b: Deposit): number {
  const size = (d: Deposit) => d.share?.max ?? d.share?.min ?? 0
  return size(b) - size(a) || (b.share?.min ?? 0) - (a.share?.min ?? 0)
}

/** Withdrawals to and deposits from an L1 address */
export function addressSummary(db: Db, address: string): AddressSummary {
  const addr = address.toLowerCase()
  const burns = all<TxnRow>(
    db,
    'select * from txn where kind = 3 and burn_addr = ? order by height',
    addr,
  )
  const mints = all<TxnRow>(
    db,
    `select txn.* from deposit
     join txn on txn.msg_hash = deposit.mint_hash and txn.kind = 2
     where deposit.depositor = ? group by txn.hash order by txn.height`,
    addr,
  )
  return {
    address: addr,
    label: labelOf(addr),
    withdrawals: burns.map((b) => withdrawalOf(db, b)),
    deposits: mints.flatMap((m) => depositOf(db, m) ?? []),
  }
}

/** Figures out what a user typed: an L1 address, a Payy tx hash or a commitment */
export function resolve(db: Db, input: string): Resolved {
  const q = input.trim().toLowerCase().replace(/^0x/, '')
  if (/^[0-9a-f]{40}$/.test(q)) return { type: 'address', address: `0x${q}` }
  if (/^[0-9a-f]{64}$/.test(q)) {
    if (getTxn(db, q)) return { type: 'txn', hash: q }
    const note = getNote(db, q)
    if (note) {
      return {
        type: 'note',
        commitment: q,
        createdTx: note.created_tx ?? undefined,
        spentTx: note.spent_tx ?? undefined,
      }
    }
  }
  return { type: 'unknown' }
}

export function status(db: Db): Status {
  const count = (table: string) =>
    one<{ n: number }>(db, `select count(*) as n from ${table}`)?.n ?? 0
  const height = one<{ h: number | null }>(
    db,
    'select max(height) as h from txn',
  )
  const block = (chain: ChainId) => {
    const value = getSync(db, `l1_${chain}_block`)
    return value ? { block: Number(value) } : undefined
  }
  return {
    payyHeight: height?.h ?? undefined,
    txns: count('txn'),
    notes: count('note'),
    deposits: count('deposit'),
    withdrawals: count('txn where kind = 3'),
    l1: { ethereum: block('ethereum'), polygon: block('polygon') },
  }
}
