import { all, type Db, getSync, one } from '../db'
import { type ChainId, labelOf, TxKind } from '../protocol'
import { inferAmounts } from './amounts'
import { collect, getNote, getTxn, type TxnRow } from './closure'
import type {
  AddressSummary,
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

/**
 * The graph around one or more transactions. Backward reaches the deposits
 * that funded them, forward the withdrawals they funded.
 */
export function graphAround(
  db: Db,
  txHashes: string[],
  direction: { backward: boolean; forward: boolean },
  limit = DEFAULT_LIMIT,
): Graph {
  const sub = collect(db, txHashes, direction, limit)
  const bounds = inferAmounts(sub)
  const deposits: Deposit[] = []
  const withdrawals: Withdrawal[] = []
  for (const t of sub.txns.values()) {
    const hops = sub.hops.get(t.hash)
    if (t.kind === TxKind.Mint) {
      const d = depositOf(db, t)
      if (d) deposits.push({ ...d, hops })
    }
    if (t.kind === TxKind.Burn) {
      withdrawals.push({ ...withdrawalOf(db, t), hops })
    }
  }
  // nearest first: the deposits few hops away are the ones that matter
  const nearestFirst = (a: { hops?: number; time: number }, b: typeof a) =>
    (a.hops ?? 0) - (b.hops ?? 0) || a.time - b.time
  return {
    txns: [...sub.txns.values()]
      .sort((a, b) => a.height - b.height || a.idx - b.idx)
      .map((t) => ({
        hash: t.hash,
        height: t.height,
        time: t.time,
        kind: t.kind,
        amount: t.amount,
      })),
    notes: [...sub.notes.values()].map((n) => ({
      commitment: n.commitment,
      from: n.created_tx ?? undefined,
      to: n.spent_tx ?? undefined,
      continues: n.spent_tx !== null && !sub.txns.has(n.spent_tx),
      ...(bounds.get(n.commitment) ?? { min: 0 }),
    })),
    deposits: deposits.sort(nearestFirst),
    withdrawals: withdrawals.sort(nearestFirst),
    truncated: sub.truncated,
  }
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
