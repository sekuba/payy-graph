import type { Db } from '../db'
import { labelOf, MIGRATION_DISTRIBUTION, TxKind } from '../protocol'
import { type Bounds, inferAmounts } from './amounts'
import {
  collect,
  getNote,
  getTxn,
  inputsOf,
  type NoteRow,
  outputsOf,
  type TxnRow,
} from './closure'
import {
  DEFAULT_LIMIT,
  depositOf,
  settlementChain,
  withdrawalOf,
} from './queries'
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
 * walked through. Each transaction on the way released notes to someone
 * else; where those ended up is looked up forward, which lists the spends
 * associated with this history.
 */
export function walkPath(db: Db, burn: TxnRow): Path {
  const steps: TxnRow[] = []
  const consumed = new Set<string>()
  let origin: PathOrigin = { type: 'limit' }
  let txn: TxnRow | undefined = burn

  const push = (t: TxnRow) => {
    steps.push(t)
    for (const n of inputsOf(db, t.hash)) consumed.add(n.commitment)
  }

  while (txn && steps.length < MAX_HOPS) {
    if (
      txn.kind === TxKind.Send &&
      txn.time >= MIGRATION_DISTRIBUTION.start &&
      txn.time < MIGRATION_DISTRIBUTION.end
    ) {
      origin = {
        type: 'migration',
        time: txn.time,
        treasury: { amount: 0, count: 0 },
      }
      break
    }
    const inputs = inputsOf(db, txn.hash)
    if (inputs.length === 2) {
      const rejoin = findRejoin(db, inputs)
      if (!rejoin) {
        origin = { type: 'merge', time: txn.time }
        break
      }
      push(txn)
      for (const t of rejoin.branches) push(t)
      txn = rejoin.split
      continue
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
    txn = getTxn(db, previous.created_tx)
  }

  // Amounts: the backward closure, plus the tx that spent each released note,
  // so a payment withdrawn in full gets its value from that withdrawal.
  const closure = collect(
    db,
    [burn.hash],
    { backward: true, forward: false },
    DEFAULT_LIMIT,
  )
  const released = steps.map((t) => ({
    txn: t,
    notes: outputsOf(db, t.hash).filter((n) => !consumed.has(n.commitment)),
  }))
  for (const { notes } of released) {
    for (const n of notes) {
      if (!n.spent_tx || closure.txns.has(n.spent_tx)) continue
      const spender = getTxn(db, n.spent_tx)
      if (!spender) continue
      closure.txns.set(spender.hash, spender)
      for (const m of [
        ...inputsOf(db, spender.hash),
        ...outputsOf(db, spender.hash),
      ]) {
        closure.notes.set(m.commitment, m)
      }
    }
  }
  const bounds = inferAmounts(closure)
  if (origin.type === 'migration') {
    origin = { ...origin, treasury: treasuryOf(db, closure.txns) }
  }

  const hops = released
    .map(({ txn, notes }) => hopOf(db, txn, notes[0], bounds))
    .sort((a, b) => a.time - b.time || a.height - b.height)
  return { withdrawal: withdrawalOf(db, burn), hops, origin }
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
): { split: TxnRow; branches: TxnRow[] } | undefined {
  if (!a || !b) return undefined
  const chainA = chainBack(db, a)
  const chainB = chainBack(db, b)
  for (const [i, split] of chainA.entries()) {
    const j = chainB.findIndex((t) => t.hash === split.hash)
    if (j >= 0) {
      return { split, branches: [...chainA.slice(0, i), ...chainB.slice(0, j)] }
    }
  }
  return undefined
}

function chainBack(db: Db, note: NoteRow): TxnRow[] {
  const chain: TxnRow[] = []
  let hash = note.created_tx
  while (hash && chain.length < REJOIN_LIMIT) {
    const t = getTxn(db, hash)
    if (!t) break
    chain.push(t)
    const ins = inputsOf(db, t.hash)
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

/** Treasury-labelled deposits among the closure's mints */
function treasuryOf(
  db: Db,
  txns: Map<string, TxnRow>,
): { amount: number; count: number } {
  let amount = 0
  let count = 0
  for (const t of txns.values()) {
    if (t.kind !== TxKind.Mint) continue
    const d = depositOf(db, t)
    if (d?.label === 'Payy treasury') {
      amount += d.amount
      count++
    }
  }
  return { amount, count }
}
