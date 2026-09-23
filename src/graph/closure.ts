import { all, type Db, one } from '../db'
import type { TxKind } from '../protocol'
import { type RoleRow, roleOf } from './roles'

export interface TxnRow {
  hash: string
  height: number
  idx: number
  time: number
  kind: TxKind
  amount: number
  msg_hash: string
  burn_addr: string | null
}

export interface NoteRow {
  commitment: string
  created_tx: string | null
  created_idx: number | null
  spent_tx: string | null
  spent_idx: number | null
}

/** A connected piece of the spend graph: transactions and the notes touching them */
export interface Subgraph {
  txns: Map<string, TxnRow>
  notes: Map<string, NoteRow>
  /** distance in transactions from the starting set */
  hops: Map<string, number>
  /** transactions not walked into because of their role, by tx hash */
  boundaries: Map<string, RoleRow>
  truncated: boolean
}

export function getTxn(db: Db, hash: string): TxnRow | undefined {
  return one<TxnRow>(db, 'select * from txn where hash = ?', hash)
}

export function getNote(db: Db, commitment: string): NoteRow | undefined {
  return one<NoteRow>(db, 'select * from note where commitment = ?', commitment)
}

export function inputsOf(db: Db, txHash: string): NoteRow[] {
  return all<NoteRow>(db, 'select * from note where spent_tx = ?', txHash)
}

export function outputsOf(db: Db, txHash: string): NoteRow[] {
  return all<NoteRow>(db, 'select * from note where created_tx = ?', txHash)
}

/**
 * Walks the graph from the given transactions. `backward` follows the notes
 * a tx consumed to the txs that created them (towards deposits), `forward`
 * follows the notes it created to the txs that spent them (towards
 * withdrawals). Each direction is followed only from the transactions it
 * reached, so the result is the ancestors and descendants of the start, not
 * everything connected to it. Every note of every visited tx is loaded, so
 * side branches are visible as edges even when their other end is not
 * expanded.
 *
 * The migration distribution and the card batches are not walked into
 * (see roles.ts): they would join the history of unrelated wallets. They
 * are recorded as boundaries, unless the walk starts inside one of them.
 */
export function collect(
  db: Db,
  start: string[],
  direction: { backward: boolean; forward: boolean },
  limit: number,
): Subgraph {
  const txns = new Map<string, TxnRow>()
  const notes = new Map<string, NoteRow>()
  const hops = new Map<string, number>()
  const boundaries = new Map<string, RoleRow>()
  const expanded = new Map<string, { backward: boolean; forward: boolean }>()
  const startRoles = new Set(start.flatMap((h) => roleOf(db, h)?.role ?? []))
  const queue = start.map((hash) => ({ hash, hop: 0, ...direction }))
  let truncated = false
  // breadth first; the queue grows while it is iterated
  for (const next of queue) {
    const done = expanded.get(next.hash)
    const backward = next.backward && !done?.backward
    const forward = next.forward && !done?.forward
    if (!backward && !forward) continue
    let txn = txns.get(next.hash)
    if (!txn) {
      if (txns.size >= limit) {
        truncated = true
        break
      }
      txn = getTxn(db, next.hash)
      if (!txn) continue
      txns.set(txn.hash, txn)
      hops.set(txn.hash, next.hop)
    }
    expanded.set(txn.hash, {
      backward: backward || !!done?.backward,
      forward: forward || !!done?.forward,
    })
    const visit = (hash: string, dir: 'backward' | 'forward') => {
      const role = roleOf(db, hash)
      if (role && !startRoles.has(role.role)) {
        boundaries.set(hash, role)
        return
      }
      queue.push({
        hash,
        hop: next.hop + 1,
        backward: dir === 'backward',
        forward: dir === 'forward',
      })
    }
    for (const note of [
      ...inputsOf(db, txn.hash),
      ...outputsOf(db, txn.hash),
    ]) {
      notes.set(note.commitment, note)
      if (backward && note.spent_tx === txn.hash && note.created_tx) {
        visit(note.created_tx, 'backward')
      }
      if (forward && note.created_tx === txn.hash && note.spent_tx) {
        visit(note.spent_tx, 'forward')
      }
    }
  }
  // side branches that end in a boundary, e.g. card payments on a backward walk
  for (const n of notes.values()) {
    for (const end of [n.created_tx, n.spent_tx]) {
      if (!end || txns.has(end) || boundaries.has(end)) continue
      const role = roleOf(db, end)
      if (role && !startRoles.has(role.role)) boundaries.set(end, role)
    }
  }
  return { txns, notes, hops, boundaries, truncated }
}

/** Transactions loaded along side branches, on top of a subgraph's own */
const SIDE_LIMIT = 200

/**
 * The subgraph plus short walks along its side branches, for amount
 * inference only:
 *
 * - back from every note that enters it from outside (in a view forward
 *   from a deposit, a note the wallet merges in from another history), so
 *   that its value can follow from where it came from;
 * - forward from every note that leaves it, of the subgraph and of that
 *   backward walk: a payment that is withdrawn or paid with the card a few
 *   transactions later gets its value from there, and with it the change
 *   its transaction kept. (A wallet that pays 3.06 out of 3.067 keeps
 *   0.007, which only shows once the 3.06 is followed to its withdrawal.)
 *
 * Nearest first, up to `limit` transactions each way.
 */
export function withSideBranches(
  db: Db,
  sub: Pick<Subgraph, 'txns' | 'notes' | 'boundaries'>,
  limit = SIDE_LIMIT,
): Pick<Subgraph, 'txns' | 'notes' | 'boundaries'> {
  const merge = (
    a: Pick<Subgraph, 'txns' | 'notes' | 'boundaries'>,
    b: Pick<Subgraph, 'txns' | 'notes' | 'boundaries'>,
  ) => ({
    txns: new Map([...b.txns, ...a.txns]),
    notes: new Map([...b.notes, ...a.notes]),
    boundaries: new Map([...b.boundaries, ...a.boundaries]),
  })
  const outside = (
    g: Pick<Subgraph, 'txns' | 'boundaries'>,
    h: string | null,
  ): h is string => !!h && !g.txns.has(h) && !g.boundaries.has(h)

  let all = sub
  const back = new Set<string>()
  for (const n of sub.notes.values()) {
    if (outside(sub, n.created_tx)) back.add(n.created_tx)
  }
  if (back.size > 0) {
    all = merge(
      all,
      collect(db, [...back], { backward: true, forward: false }, limit),
    )
  }
  const ahead = new Set<string>()
  for (const n of all.notes.values()) {
    if (outside(all, n.spent_tx)) ahead.add(n.spent_tx)
  }
  if (ahead.size > 0) {
    all = merge(
      all,
      collect(db, [...ahead], { backward: false, forward: true }, limit),
    )
  }
  return all
}
