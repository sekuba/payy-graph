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
