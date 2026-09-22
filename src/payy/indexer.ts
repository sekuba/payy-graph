import { type Db, getSync, setSync, transaction } from '../db'
import { log, sleep } from '../log'
import { TxKind, ZERO_COMMITMENT } from '../protocol'
import { type PayyNode, type TxnSnapshot, toSnapshot } from './api'

const CURSOR_KEY = 'payy_cursor'

/** A Payy transaction reduced to what the spend graph needs */
export interface TxnRecord {
  hash: string
  height: number
  index: number
  time: number
  kind: TxKind
  /** notes consumed and created, padding removed */
  inputs: string[]
  outputs: string[]
  /** minted or burned amount, 0 for sends */
  amount: number
  /** mint hash for mints, burn hash (= inputs[0]) for burns, zero for sends */
  msgHash: string
  /** L1 recipient for burns */
  burnAddr: string | undefined
}

export function parseTxn(t: TxnSnapshot): TxnRecord {
  const { input_commitments, output_commitments, messages } = t.public_inputs
  const kind = Number(BigInt(`0x${messages[0]}`)) as TxKind
  return {
    hash: t.hash,
    height: t.block_height,
    index: t.index_in_block,
    time: t.time,
    kind,
    inputs: input_commitments.filter((c) => c !== ZERO_COMMITMENT),
    outputs: output_commitments.filter((c) => c !== ZERO_COMMITMENT),
    amount: Number(BigInt(`0x${messages[2]}`)),
    msgHash: messages[3],
    burnAddr: kind === TxKind.Burn ? `0x${messages[4].slice(24)}` : undefined,
  }
}

/**
 * Writes a batch of transactions and their note edges, idempotently. The
 * caller wraps this in a transaction.
 */
export function insertTxns(db: Db, records: TxnRecord[]): void {
  const insertTxn = db.prepare(
    `insert into txn (hash, height, idx, time, kind, amount, msg_hash, burn_addr)
     values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (hash) do nothing`,
  )
  const created = db.prepare(
    `insert into note (commitment, created_tx, created_idx) values (?, ?, ?)
     on conflict (commitment) do update set
       created_tx = excluded.created_tx, created_idx = excluded.created_idx`,
  )
  const spent = db.prepare(
    `insert into note (commitment, spent_tx, spent_idx) values (?, ?, ?)
     on conflict (commitment) do update set
       spent_tx = excluded.spent_tx, spent_idx = excluded.spent_idx`,
  )
  for (const r of records) {
    insertTxn.run(
      r.hash,
      r.height,
      r.index,
      r.time,
      r.kind,
      r.amount,
      r.msgHash,
      r.burnAddr ?? null,
    )
    r.outputs.forEach((c, i) => {
      created.run(c, r.hash, i)
    })
    r.inputs.forEach((c, i) => {
      spent.run(c, r.hash, i)
    })
  }
}

/**
 * Pages through the node's transaction history from the saved cursor. With
 * `follow` it keeps polling for new blocks once it has caught up.
 */
export async function syncPayy(
  db: Db,
  node: PayyNode,
  options: { follow: boolean },
): Promise<void> {
  let cursor = getSync(db, CURSOR_KEY)
  let total = 0
  const startedAt = Date.now()
  for (;;) {
    const { txns, after } = await node.listTransactions(cursor)
    if (txns.length === 0) {
      if (!options.follow) break
      await sleep(10_000)
      continue
    }
    const records = txns.map((t) => parseTxn(toSnapshot(t)))
    transaction(db, () => {
      insertTxns(db, records)
      if (after) setSync(db, CURSOR_KEY, after)
    })
    cursor = after ?? cursor
    total += records.length
    if (total % 5000 < records.length) {
      const last = records[records.length - 1]
      log('payy sync', {
        txns: total,
        height: last?.height,
        rate: `${Math.round(total / ((Date.now() - startedAt) / 1000))}/s`,
      })
    }
    if (!after) {
      if (!options.follow) break
      await sleep(10_000)
    }
  }
  log('payy sync done', { txns: total })
}
