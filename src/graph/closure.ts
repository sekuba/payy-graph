import { all, type Db, one } from '../db'
import type { TxKind } from '../protocol'

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
  truncated: boolean
}

export function getTxn(db: Db, hash: string): TxnRow | undefined {
  return one<TxnRow>(db, 'select * from txn where hash = ?', hash)
}

export function getNote(db: Db, commitment: string): NoteRow | undefined {
  return one<NoteRow>(db, 'select * from note where commitment = ?', commitment)
}

function notesOf(db: Db, txHash: string): NoteRow[] {
  return all<NoteRow>(
    db,
    'select * from note where created_tx = ? or spent_tx = ?',
    txHash,
    txHash,
  )
}

/**
 * Walks the graph from the given transactions. `backward` follows the notes
 * a tx consumed to the txs that created them (towards deposits), `forward`
 * follows the notes it created to the txs that spent them (towards
 * withdrawals). Every note of every visited tx is loaded, so side branches
 * are visible as edges even when their other end is not expanded.
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
  const queue = start.map((hash) => ({ hash, hop: 0 }))
  let truncated = false
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined || txns.has(next.hash)) continue
    if (txns.size >= limit) {
      truncated = true
      break
    }
    const txn = getTxn(db, next.hash)
    if (!txn) continue
    txns.set(next.hash, txn)
    hops.set(next.hash, next.hop)
    for (const note of notesOf(db, next.hash)) {
      notes.set(note.commitment, note)
      const hop = next.hop + 1
      if (direction.backward && note.spent_tx === txn.hash && note.created_tx) {
        queue.push({ hash: note.created_tx, hop })
      }
      if (direction.forward && note.created_tx === txn.hash && note.spent_tx) {
        queue.push({ hash: note.spent_tx, hop })
      }
    }
  }
  return { txns, notes, hops, truncated }
}
