import { createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { all, type Db, setSync, transaction } from '../db'
import { log } from '../log'
import { NOTE_KIND_USDC, TxKind, ZERO_COMMITMENT } from '../protocol'
import type { PublicInputs, TxnSnapshot } from './api'
import { insertTxns, parseTxn } from './indexer'

/**
 * The spend graph is nothing more than the public inputs of every Payy
 * transaction. Payy publishes them only through its own node, so this module
 * keeps a copy that is independent of that node: one JSON line per
 * transaction, oldest first, in the node's own field names.
 */

interface TxnRow {
  hash: string
  height: number
  idx: number
  time: number
  kind: TxKind
  amount: number
  msg_hash: string
  burn_addr: string | null
}

interface NoteRow {
  commitment: string
  idx: number
}

export function exportSnapshot(db: Db, path: string): void {
  const out = createWriteStream(path)
  const txns = db
    .prepare('select * from txn order by height, idx')
    .iterate() as Iterable<TxnRow>
  const outputs = (hash: string) =>
    all<NoteRow>(
      db,
      'select commitment, created_idx as idx from note where created_tx = ?',
      hash,
    )
  const inputs = (hash: string) =>
    all<NoteRow>(
      db,
      'select commitment, spent_idx as idx from note where spent_tx = ?',
      hash,
    )
  let count = 0
  for (const t of txns) {
    const snapshot: TxnSnapshot = {
      hash: t.hash,
      block_height: t.height,
      index_in_block: t.idx,
      time: t.time,
      public_inputs: publicInputs(t, inputs(t.hash), outputs(t.hash)),
    }
    out.write(`${JSON.stringify(snapshot)}\n`)
    count++
  }
  out.end()
  log('exported', { txns: count, path })
}

/** Rebuilds the proof's public inputs from the stored rows */
function publicInputs(
  t: TxnRow,
  inputs: NoteRow[],
  outputs: NoteRow[],
): PublicInputs {
  const pair = (notes: NoteRow[]): [string, string] => {
    const pair: [string, string] = [ZERO_COMMITMENT, ZERO_COMMITMENT]
    for (const n of notes) pair[n.idx] = n.commitment
    return pair
  }
  const word = (hex: string) => hex.padStart(64, '0')
  const isSend = t.kind === TxKind.Send
  return {
    input_commitments: pair(inputs),
    output_commitments: pair(outputs),
    messages: [
      word(t.kind.toString(16)),
      isSend ? ZERO_COMMITMENT : NOTE_KIND_USDC,
      word(t.amount.toString(16)),
      isSend ? ZERO_COMMITMENT : t.msg_hash,
      t.burn_addr ? word(t.burn_addr.slice(2)) : ZERO_COMMITMENT,
    ],
  }
}

/**
 * Loads a snapshot and positions the sync cursor right after its last
 * transaction, so `sync` continues from there instead of refetching.
 */
export async function importSnapshot(db: Db, path: string): Promise<void> {
  const lines = createInterface({ input: createReadStream(path) })
  let batch: TxnSnapshot[] = []
  let last: TxnSnapshot | undefined
  let count = 0
  const flush = () => {
    const records = batch.map(parseTxn)
    transaction(db, () => insertTxns(db, records))
    count += batch.length
    batch = []
  }
  for await (const line of lines) {
    if (!line.trim()) continue
    const t = JSON.parse(line) as TxnSnapshot
    batch.push(t)
    last = t
    if (batch.length >= 5000) {
      flush()
      if (count % 100_000 === 0) log('import', { txns: count })
    }
  }
  flush()
  if (last) setSync(db, 'payy_cursor', cursorAfter(last))
  log('imported', { txns: count, height: last?.block_height })
}

/**
 * The node's opaque cursor is base64 JSON of a position
 * (payy repo: pkg/primitives/src/pagination.rs and node rpc routes/txn.rs).
 */
function cursorAfter(t: TxnSnapshot): string {
  const position = {
    AfterInclusive: { block: t.block_height, txn: t.index_in_block },
  }
  return Buffer.from(JSON.stringify(position)).toString('base64')
}
