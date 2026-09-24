import { all, type Db, getSync, one, setSync, transaction } from '../db'
import { DUST } from '../format'
import { FUNDING_DONE_KEY } from '../l1/bridges'
import { log } from '../log'
import { CARD_SETTLEMENT, type ChainId, TxKind } from '../protocol'
import { collect, type TxnRow } from './closure'
import { walkPath } from './path'
import { DEFAULT_LIMIT, depositOf, ownerOf } from './queries'
import { sameAs } from './senders'
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
 * through. 3: the walk goes ten times further back. 4: the sender behind
 * most of the withdrawal is stored, for every withdrawal. 5: senders are
 * owners (src/graph/identity.ts); traced again once the funding of every
 * deposit has been looked up, so that the owners are complete. 6: a
 * withdrawal that consumed no note has its own origin.
 */
const VERSION = 6
const RETRACE: Record<number, string[]> = {
  2: ['merge', 'limit'],
  3: ['limit'],
  4: ['deposit', 'merge', 'limit', 'migration'],
  5: ['deposit', 'merge', 'limit', 'migration'],
  6: ['limit'],
}
/** Versions that wait for the funding backfill (src/l1/bridges.ts) */
const NEEDS_FUNDING = 5

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
  sender: string | null
  sender_chain: number | null
  sender_deposits: number | null
  sender_min: number | null
  sender_max: number | null
  sender_same: string | null
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
    ...(row.sender && {
      sender: {
        address: row.sender,
        chain: row.sender_chain ?? undefined,
        deposits: row.sender_deposits ?? 1,
        min: row.sender_min ?? 0,
        max: row.sender_max ?? undefined,
        ...(row.sender_same && {
          same: row.sender_same as 'address' | 'owner',
        }),
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
  const top = path.senders[0]
  // the recipient is the sender: literally, or one of the sender's group
  const recipient = burn.burn_addr ?? ''
  const same = top && sameAs(top, recipient, ownerOf(db, recipient))
  const sender =
    top && top.share.min >= DUST
      ? {
          address: top.address,
          chain: top.chain,
          deposits: top.deposits,
          min: top.share.min,
          max: top.share.max,
          ...(same && { same }),
          ...(top.paid && { paid: true }),
        }
      : undefined
  return {
    ...(sender && { sender }),
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
  const target =
    getSync(db, FUNDING_DONE_KEY) === '1' ? VERSION : NEEDS_FUNDING - 1
  if (version < target) {
    const origins = new Set<string>()
    for (let v = version + 1; v <= target; v++) {
      for (const o of RETRACE[v] ?? []) origins.add(o)
    }
    transaction(db, () => {
      const list = [...origins].map((o) => `'${o}'`).join(', ')
      if (list) db.exec(`delete from trace where origin in (${list})`)
      setSync(db, BACKFILL_KEY, String(top))
      setSync(db, VERSION_KEY, String(target))
    })
    log('traces', { version: target, retracing: [...origins].join(', ') })
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
       deposit_time, deposit_amount, deposit_hops, depositors, nearest, truncated,
       sender, sender_chain, sender_deposits, sender_min, sender_max,
       sender_same)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (burn_tx) do nothing`,
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
      t.sender?.address ?? null,
      t.sender?.chain ?? null,
      t.sender?.deposits ?? null,
      t.sender?.min ?? null,
      t.sender?.max ?? null,
      t.sender?.same ?? null,
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
