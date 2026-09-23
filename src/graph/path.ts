import type { Db } from '../db'
import { DUST } from '../format'
import { labelOf, TxKind } from '../protocol'
import type { Bounds } from './amounts'
import {
  collect,
  getNote,
  getTxn,
  inputsOf,
  type NoteRow,
  outputsOf,
  type TxnRow,
  withSideBranches,
} from './closure'
import {
  bySize,
  cardBatchOf,
  DEFAULT_LIMIT,
  depositOf,
  inferWithBatches,
  settlementChain,
  withdrawalOf,
} from './queries'
import { migrationSummary, Role, roleOf } from './roles'
import { flowInto } from './sources'
import type { Destination, Path, PathHop, PathOrigin } from './types'

const MAX_HOPS = 300
/** how far to follow a payment note forward when looking for its payout */
const FORWARD_LIMIT = 40
/** how far two merged notes may be apart before they count as separate histories */
const REJOIN_LIMIT = 12

/**
 * The history of one withdrawal as a story: walk back along the note that
 * was burned, through the transactions that spent the previous note and kept
 * the change, until the funds came from a deposit, were consolidated from two
 * separate histories, or arrived in the migration distribution. A note split
 * in two and merged back a few steps later is the same wallet's doing and is
 * walked through. So is a merge with a note that provably held less than a
 * cent: the funds did not come from there, and the note is listed as merged
 * in. Each transaction on the way released notes to someone else; where
 * those ended up is looked up forward, which lists the spends associated
 * with this history.
 */
export function walkPath(db: Db, burn: TxnRow): Path {
  // Amounts first, which tell dust from funds: the backward closure, plus
  // side branches followed forward, so a payment withdrawn in full gets its
  // value from that withdrawal, and the card batch of each card payment,
  // which bounds it.
  const closure = collect(
    db,
    [burn.hash],
    { backward: true, forward: false },
    DEFAULT_LIMIT,
  )
  const bounds = inferWithBatches(db, withSideBranches(db, closure))
  const dust = (n: NoteRow) => {
    const b = bounds.get(n.commitment)
    const hi = b?.value ?? b?.max
    return hi !== undefined && hi < DUST
  }

  const steps: TxnRow[] = []
  const consumed = new Set<string>()
  let origin: PathOrigin = { type: 'limit' }
  let txn: TxnRow | undefined = burn
  /** the note the walk followed into `txn` */
  let followed: NoteRow | undefined

  const push = (t: TxnRow) => {
    steps.push(t)
    for (const n of inputsOf(db, t.hash)) consumed.add(n.commitment)
  }

  while (txn && steps.length < MAX_HOPS) {
    if (roleOf(db, txn.hash)?.role === Role.Migration) {
      origin = {
        type: 'migration',
        time: txn.time,
        distribution: migrationSummary(db),
      }
      break
    }
    const inputs = inputsOf(db, txn.hash)
    if (inputs.length === 2) {
      const rejoin = findRejoin(db, inputs, dust)
      if (rejoin) {
        push(txn)
        for (const t of rejoin.branches) push(t)
        txn = rejoin.split
        followed = undefined
        continue
      }
      const funds = inputs.filter((n) => !dust(n))
      if (funds.length !== 1) {
        origin = { type: 'merge', time: txn.time }
        break
      }
      inputs.splice(0, 2, ...funds)
    }
    push(txn)
    if (txn.kind === TxKind.Mint && inputs.length === 0) {
      origin = {
        type: 'deposit',
        amount: txn.amount,
        time: txn.time,
        deposit: depositOf(db, txn),
      }
      break
    }
    const previous = inputs[0]
    if (!previous?.created_tx) break
    followed = previous
    txn = getTxn(db, previous.created_tx)
  }

  const released = steps.map((t) => ({
    txn: t,
    notes: outputsOf(db, t.hash).filter((n) => !consumed.has(n.commitment)),
  }))
  // what the migrated note held follows from what the wallet did with it
  if (origin.type === 'migration' && followed) {
    const b = bounds.get(followed.commitment)
    if (b) origin = { ...origin, value: b.value, min: b.min, max: b.max }
  }

  const hops = released
    .map(({ txn, notes }) => hopOf(db, txn, notes[0], bounds))
    .sort((a, b) => a.time - b.time || a.height - b.height)
  markRecurring(hops)
  const { shares } = flowInto(closure, bounds, [burn.hash])
  const sources = [...closure.txns.values()]
    .flatMap((t) => {
      const d = t.kind === TxKind.Mint && depositOf(db, t)
      return d ? [{ ...d, share: shares.get(t.hash) }] : []
    })
    .sort(bySize)
  // notes from outside the walked history, merged in on the way
  // (not the note the walk arrived by where it stopped: a merge, the
  // migration or the limit)
  const walked = new Set(steps.map((t) => t.hash))
  const stoppedAt = txn && !walked.has(txn.hash) ? txn.hash : undefined
  const merged = steps.flatMap((t) =>
    inputsOf(db, t.hash)
      .filter(
        (n) =>
          n.created_tx &&
          !walked.has(n.created_tx) &&
          n.created_tx !== stoppedAt,
      )
      .map((n) => ({
        txHash: t.hash,
        time: t.time,
        ...(bounds.get(n.commitment) ?? { min: 0 }),
      })),
  )
  return {
    withdrawal: withdrawalOf(db, burn),
    hops,
    origin,
    sources,
    merged,
  }
}

/**
 * Card payments on the same day of the month at the same hour, in at least
 * three different months, are marked as recurring. Payy wallets pay some
 * charges this way; which charge it is does not show onchain.
 */
function markRecurring(hops: PathHop[]): void {
  const slots = new Map<string, PathHop[]>()
  for (const hop of hops) {
    if (hop.out?.destination.type !== 'card') continue
    const d = new Date(hop.time * 1000)
    const key = `${d.getUTCDate()} ${d.getUTCHours()}`
    const list = slots.get(key) ?? []
    list.push(hop)
    slots.set(key, list)
  }
  for (const list of slots.values()) {
    const months = new Set(
      list.map((h) => new Date(h.time * 1000).toISOString().slice(0, 7)),
    )
    if (months.size >= 3) for (const h of list) h.recurring = true
  }
}

/**
 * For a merge of two notes: walk each note's history back along single-input
 * transactions and look for the transaction both descend from. If it exists
 * nearby, the wallet split a note and merged it back; the transactions in
 * between are part of its own history.
 */
function findRejoin(
  db: Db,
  [a, b]: NoteRow[],
  dust: (n: NoteRow) => boolean,
): { split: TxnRow; branches: TxnRow[] } | undefined {
  if (!a || !b) return undefined
  const chainA = chainBack(db, a, dust)
  const chainB = chainBack(db, b, dust)
  for (const [i, split] of chainA.entries()) {
    const j = chainB.findIndex((t) => t.hash === split.hash)
    if (j >= 0) {
      return { split, branches: [...chainA.slice(0, i), ...chainB.slice(0, j)] }
    }
  }
  return undefined
}

/** Back along single-input transactions, and merges with dust */
function chainBack(
  db: Db,
  note: NoteRow,
  dust: (n: NoteRow) => boolean,
): TxnRow[] {
  const chain: TxnRow[] = []
  let hash = note.created_tx
  while (hash && chain.length < REJOIN_LIMIT) {
    const t = getTxn(db, hash)
    if (!t) break
    chain.push(t)
    const ins = inputsOf(db, t.hash).filter((n) => !dust(n))
    if (ins.length !== 1) break
    hash = ins[0]?.created_tx ?? null
  }
  return chain
}

function hopOf(
  db: Db,
  txn: TxnRow,
  released: NoteRow | undefined,
  bounds: Map<string, Bounds>,
): PathHop {
  const kind =
    txn.kind === TxKind.Burn
      ? 'withdrawal'
      : txn.kind === TxKind.Mint
        ? 'deposit'
        : 'send'
  const hop: PathHop = {
    txHash: txn.hash,
    time: txn.time,
    height: txn.height,
    kind,
  }
  if (txn.kind === TxKind.Burn) {
    hop.amount = txn.amount
    hop.recipient = txn.burn_addr ?? undefined
    hop.label = hop.recipient ? labelOf(hop.recipient) : undefined
    hop.chain = settlementChain(db, txn.height)
  }
  if (txn.kind === TxKind.Mint) {
    hop.amount = txn.amount
    const deposit = depositOf(db, txn)
    if (deposit) {
      hop.depositor = deposit.depositor
      hop.label = deposit.label
      hop.chain = deposit.chain
      hop.l1Tx = deposit.l1Tx
    }
  }
  if (released) {
    const b = bounds.get(released.commitment)
    hop.out = {
      commitment: released.commitment,
      value: b?.value,
      min: b?.min ?? 0,
      max: b?.max,
      destination: destinationOf(db, released),
    }
  }
  return hop
}

/** Follows a note forward until the funds leave the network */
function destinationOf(db: Db, note: NoteRow): Destination {
  if (!note.spent_tx) return { type: 'unspent' }
  const role = roleOf(db, note.spent_tx)
  const batch = role?.role === Role.Card && cardBatchOf(db, role.batch)
  if (batch) return { type: 'card', batch }
  const spender = getTxn(db, note.spent_tx)
  if (spender?.kind === TxKind.Burn) {
    const recipient = spender.burn_addr ?? ''
    return {
      type: 'withdrawn',
      recipient,
      label: labelOf(recipient),
      chain: settlementChain(db, spender.height),
      time: spender.time,
      amount: spender.amount,
    }
  }
  const recipients = new Map<string, number>()
  const seen = new Set<string>()
  const queue = [note.commitment]
  // breadth first; the queue grows while it is iterated
  for (const commitment of queue) {
    if (seen.size >= FORWARD_LIMIT) break
    const n = getNote(db, commitment)
    if (!n?.spent_tx || seen.has(n.spent_tx)) continue
    seen.add(n.spent_tx)
    const t = getTxn(db, n.spent_tx)
    if (!t) continue
    if (t.kind === TxKind.Burn) {
      const r = t.burn_addr ?? ''
      recipients.set(r, (recipients.get(r) ?? 0) + 1)
      continue
    }
    for (const o of outputsOf(db, t.hash)) queue.push(o.commitment)
  }
  if (recipients.size === 0) return { type: 'circulating' }
  return {
    type: 'collected',
    recipients: [...recipients]
      .sort((a, b) => b[1] - a[1])
      .map(([address, count]) => ({ address, label: labelOf(address), count })),
  }
}
