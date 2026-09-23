import { all, type Db, getSync, one, setSync, transaction } from '../db'
import { log } from '../log'
import { CARD_SETTLEMENT, type ChainId, TxKind } from '../protocol'
import { collect, type TxnRow } from './closure'
import { walkPath } from './path'
import { DEFAULT_LIMIT, depositOf } from './queries'
import type { Trace } from './types'

/**
 * Where each withdrawal's funds came from, stored so that the live view can
 * show it for every withdrawal without walking the graph per request:
 *
 * - the origin of its history (walkPath): one deposit, the migration, or a
 *   merge of two histories;
 * - the deposits in its backward closure (as far as DEFAULT_LIMIT goes):
 *   how many distinct addresses deposited them and how close the nearest is.
 *
 * Card batches are not traced; they are Payy's own withdrawals.
 */

const NEW_KEY = 'traces_height'
const BACKFILL_KEY = 'traces_backfill_height'
const VERSION_KEY = 'traces_version'
/**
 * Bumped when the walk changes what it finds, with the origins that are
 * traced again. 2: merges with a note of less than a cent are walked
 * through. 3: the walk goes ten times further back.
 */
const VERSION = 3
const RETRACE: Record<number, string[]> = {
  2: ['merge', 'limit'],
  3: ['limit'],
}

interface TraceRow {
  burn_tx: string
  height: number
  origin: Trace['origin']
  depositor: string | null
  deposit_chain: ChainId | null
  deposit_time: number | null
  deposit_amount: number | null
  deposit_hops: number | null
  depositors: number
  nearest: number | null
  truncated: number
}

export function traceOf(db: Db, burnTx: string): Trace | undefined {
  const row = one<TraceRow>(db, 'select * from trace where burn_tx = ?', burnTx)
  return row && fromRow(row)
}

export function fromRow(row: TraceRow): Trace {
  return {
    origin: row.origin,
    ...(row.depositor &&
      row.deposit_chain && {
        source: {
          depositor: row.depositor,
          chain: row.deposit_chain,
          time: row.deposit_time ?? 0,
          amount: row.deposit_amount ?? 0,
          hops: row.deposit_hops ?? 0,
        },
      }),
    depositors: row.depositors,
    nearest: row.nearest ?? undefined,
    truncated: row.truncated === 1,
  }
}

export function computeTrace(db: Db, burn: TxnRow): Trace {
  const path = walkPath(db, burn, DEFAULT_LIMIT)
  const closure = collect(
    db,
    [burn.hash],
    { backward: true, forward: false },
    DEFAULT_LIMIT,
  )
  const depositors = new Set<string>()
  let nearest: number | undefined
  for (const t of closure.txns.values()) {
    if (t.kind !== TxKind.Mint) continue
    const d = depositOf(db, t)
    if (!d) continue
    depositors.add(d.depositor)
    const hops = closure.hops.get(t.hash) ?? 0
    nearest = nearest === undefined ? hops : Math.min(nearest, hops)
  }
  const o = path.origin
  const deposit = o.type === 'deposit' ? o.deposit : undefined
  return {
    origin: o.type,
    ...(deposit && {
      source: {
        depositor: deposit.depositor,
        chain: deposit.chain,
        time: deposit.time,
        amount: deposit.amount,
        hops: closure.hops.get(deposit.txHash) ?? path.hops.length - 1,
      },
    }),
    depositors: depositors.size,
    nearest,
    truncated: closure.truncated,
  }
}

/**
 * Traces new withdrawals, then older ones, newest first, until `budgetMs`
 * is used up; called each time the sync catches up, so the history is
 * backfilled a slice at a time without holding up the sync.
 */
export function deriveTraces(db: Db, budgetMs: number): void {
  const started = Date.now()
  const top =
    one<{ h: number | null }>(db, 'select max(height) as h from txn')?.h ?? 0
  const version = Number(getSync(db, VERSION_KEY) ?? 1)
  if (version < VERSION) {
    const origins = new Set<string>()
    for (let v = version + 1; v <= VERSION; v++) {
      for (const o of RETRACE[v] ?? []) origins.add(o)
    }
    transaction(db, () => {
      const list = [...origins].map((o) => `'${o}'`).join(', ')
      if (list) db.exec(`delete from trace where origin in (${list})`)
      setSync(db, BACKFILL_KEY, String(top))
      setSync(db, VERSION_KEY, String(VERSION))
    })
    log('traces', { version: VERSION, retracing: [...origins].join(', ') })
  }
  const done = Number(getSync(db, NEW_KEY) ?? top)
  const backfill = Number(getSync(db, BACKFILL_KEY) ?? done)
  const placeholders = CARD_SETTLEMENT.map(() => '?').join(', ')
  // small batches: each tx is written in one sqlite transaction
  const pending = (where: string, bound: number) =>
    all<TxnRow>(
      db,
      `select * from txn where kind = ${TxKind.Burn} and ${where}
       and burn_addr not in (${placeholders})
       and not exists (select 1 from trace where burn_tx = txn.hash)
       order by height desc limit 25`,
      bound,
      ...CARD_SETTLEMENT,
    )
  const insert = db.prepare(
    `insert into trace (burn_tx, height, origin, depositor, deposit_chain,
       deposit_time, deposit_amount, deposit_hops, depositors, nearest, truncated)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (burn_tx) do nothing`,
  )
  const save = (burn: TxnRow, t: Trace) =>
    insert.run(
      burn.hash,
      burn.height,
      t.origin,
      t.source?.depositor ?? null,
      t.source?.chain ?? null,
      t.source?.time ?? null,
      t.source?.amount ?? null,
      t.source?.hops ?? null,
      t.depositors,
      t.nearest ?? null,
      t.truncated ? 1 : 0,
    )
  const traceAll = (burns: TxnRow[]) => {
    const traces = burns.map((b) => [b, computeTrace(db, b)] as const)
    transaction(db, () => {
      for (const [b, t] of traces) save(b, t)
    })
  }
  let traced = 0

  // new withdrawals first, all of them
  for (;;) {
    const fresh = pending('height > ?', done)
    if (fresh.length === 0) break
    traceAll(fresh)
    traced += fresh.length
  }
  setSync(db, NEW_KEY, String(top))

  // then the history, newest first, while there is time
  let cursor = backfill
  while (cursor > 0 && Date.now() - started < budgetMs) {
    const older = pending('height <= ?', cursor)
    if (older.length === 0) {
      cursor = 0
    } else {
      traceAll(older)
      cursor = older[older.length - 1]?.height ?? 0
      traced += older.length
    }
    setSync(db, BACKFILL_KEY, String(cursor))
  }
  if (traced > 0) log('traces', { traced, backfill: cursor })
}
