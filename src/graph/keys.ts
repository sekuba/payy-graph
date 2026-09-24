import { all, type Db, getSync, one, setSync, transaction } from '../db'
import { log } from '../log'
import { CARD_SETTLEMENT, labelOf, TxKind } from '../protocol'
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
import { inferWithBatches } from './queries'
import { migrationSummary, Role, roleOf } from './roles'
import type {
  BurnShape,
  FirstSpend,
  HeldStats,
  KeyStats,
  MigratedNote,
  Sweep,
} from './types'

/**
 * Whose keys spend the notes in users' wallets. Payy's app derives the keys
 * of the notes it creates for itself on the device, but a note that arrives
 * from Payy's server carries a key the server made or saw (the migration
 * of 2025-09-12, links, ramps, the card). The public graph cannot see keys,
 * but it can see what happened to such notes and when:
 *
 * - The migration distribution released about 3,000 notes to wallets under
 *   keys the server generated (`migrated` table). For each: what first
 *   spent it, how long after, and what it held as far as the graph
 *   determines it. A send with one input and one output right after issue
 *   would be the wallet moving the balance to a key of its own; a payment,
 *   a card charge or a withdrawal straight from the note means it was
 *   spent under the key the server made.
 * - Sweeps (`sweep` table): a two-input transaction that consumes a note
 *   at least a day old together with one made minutes before, the two from
 *   separate histories. A wallet consolidating its own funds looks the
 *   same, so this is only counted, with the value of the old note where
 *   the graph bounds it.
 * - Withdrawals by shape: whether the note a withdrawal burns was made by a
 *   1-in/1-out send just before, for withdrawals with and without change.
 *
 * All three are derived a slice at a time from the sync (like traces) and
 * summarised by `keyStats` for the API.
 */

/** transactions followed forward from a migrated note's first spend, to bound it */
const MIGRATED_FORWARD = 120
/** a sweep's old note is at least this old, its fresh note at most this */
const SWEEP_OLD = 24 * 3600
const SWEEP_FRESH = 10 * 60
/** transactions back in which the two notes may not share an ancestor */
const SWEEP_APART = 12
/** transactions loaded behind a sweep to bound its notes, and along side branches */
const SWEEP_BACK = 60
const SWEEP_SIDE = 100
/** transactions looked at ahead of a sweep for a withdrawal */
const SWEEP_AHEAD = 8
/** transactions per scanning step of the sweep cursor */
const SWEEP_STEP = 2000
/** an old note of at most this counts as small */
export const SMALL = 1_000_000
/** how often the burn shapes are counted again */
const BURNS_TTL = 24 * 3600
const EXAMPLES = 3

const SWEEP_KEY = 'sweeps_height'
const BURNS_KEY = 'keys_burns'

interface MigratedRow {
  commitment: string
  created_tx: string
  created_time: number
  change: number
  first: FirstSpend | null
  spent_tx: string | null
  spent_time: number | null
  spender_inputs: number | null
  spender_outputs: number | null
  burn_amount: number | null
  burn_addr: string | null
  value: number | null
  min: number | null
  max: number | null
  truncated: number | null
}

interface SweepRow {
  tx: string
  height: number
  time: number
  kind: TxKind
  outputs: number
  old_commitment: string
  old_tx: string
  old_age: number
  fresh_commitment: string
  fresh_tx: string
  fresh_age: number
  fresh_kind: TxKind
  old_value: number | null
  old_min: number
  old_max: number | null
  fresh_value: number | null
  fresh_min: number
  fresh_max: number | null
  burn_tx: string | null
  burn_hops: number | null
  burn_addr: string | null
  burn_amount: number | null
}

/** Brings the three derivations up to date, within `budgetMs` */
export function deriveKeys(db: Db, budgetMs: number): void {
  const deadline = Date.now() + budgetMs
  deriveMigrated(db, deadline)
  deriveSweeps(db, deadline)
  deriveBurnShapes(db)
}

// ---- migrated notes ------------------------------------------------------

/**
 * Lists the notes the distribution released once the roles are known, then
 * classifies them: what first spent each, and what the graph says it held.
 * Unspent notes are looked at again each time.
 */
export function deriveMigrated(db: Db, deadline: number): void {
  if (!migrationSummary(db)) return
  if (!one(db, 'select 1 from migrated limit 1')) {
    const released = all<{
      commitment: string
      created_tx: string
      created_idx: number
      time: number
    }>(
      db,
      `select n.commitment, n.created_tx, n.created_idx, c.time
       from note n join role r on r.tx = n.created_tx and r.role = ${Role.Migration}
       join txn c on c.hash = n.created_tx
       where n.spent_tx is null
         or n.spent_tx not in (select tx from role where role = ${Role.Migration})`,
    )
    transaction(db, () => {
      const insert = db.prepare(
        `insert into migrated (commitment, created_tx, created_time, change)
         values (?, ?, ?, ?) on conflict (commitment) do nothing`,
      )
      for (const n of released) {
        // a payout's output 1 is the change the next payout spends; one
        // that nothing in the distribution spent ends a chain
        insert.run(
          n.commitment,
          n.created_tx,
          n.time,
          n.created_idx === 1 ? 1 : 0,
        )
      }
    })
    log('migrated notes', { released: released.length })
  }
  const pending = all<MigratedRow>(
    db,
    `select * from migrated where first is null or first = 'unspent'`,
  )
  const update = db.prepare(
    `update migrated set first = ?, spent_tx = ?, spent_time = ?,
       spender_inputs = ?, spender_outputs = ?, burn_amount = ?, burn_addr = ?,
       value = ?, min = ?, max = ?, truncated = ?
     where commitment = ?`,
  )
  let classified = 0
  for (const row of pending) {
    if (Date.now() > deadline) break
    const note = getNote(db, row.commitment)
    if (!note?.spent_tx) {
      if (row.first !== 'unspent') {
        update.run(
          'unspent',
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          row.commitment,
        )
        classified++
      }
      continue
    }
    const spender = getTxn(db, note.spent_tx)
    if (!spender) continue
    const inputs = inputsOf(db, spender.hash)
    const outputs = outputsOf(db, spender.hash)
    const first = firstSpendOf(db, spender, inputs, outputs)
    const sub = collect(
      db,
      [spender.hash],
      { backward: false, forward: true },
      MIGRATED_FORWARD,
    )
    const b = inferWithBatches(db, withSideBranches(db, sub)).get(
      row.commitment,
    )
    update.run(
      first,
      spender.hash,
      spender.time,
      inputs.length,
      outputs.length,
      spender.kind === TxKind.Burn ? spender.amount : null,
      spender.kind === TxKind.Burn ? spender.burn_addr : null,
      b?.value ?? null,
      b?.value ?? b?.min ?? 0,
      b?.value ?? b?.max ?? null,
      sub.truncated ? 1 : 0,
      row.commitment,
    )
    classified++
  }
  if (classified > 0) log('migrated notes', { classified })
}

/** What kind of transaction first spent a migrated note */
export function firstSpendOf(
  db: Db,
  spender: TxnRow,
  inputs: NoteRow[],
  outputs: NoteRow[],
): FirstSpend {
  if (spender.kind === TxKind.Burn) return 'burn'
  if (inputs.length === 2) return 'merge'
  if (inputs.length === 1 && outputs.length === 1) return 'rekey'
  if (inputs.length === 1 && outputs.length === 2) {
    const card = outputs.some(
      (o) => o.spent_tx && roleOf(db, o.spent_tx)?.role === Role.Card,
    )
    return card ? 'card' : 'send'
  }
  return 'other'
}

// ---- sweeps --------------------------------------------------------------

/**
 * Scans the history in height order for two-input transactions outside the
 * migration and the card batches whose inputs are an old note and a fresh
 * one from separate histories, and bounds both notes.
 */
export function deriveSweeps(db: Db, deadline: number): void {
  const top =
    one<{ h: number | null }>(db, 'select max(height) as h from txn')?.h ?? 0
  let cursor = Number(getSync(db, SWEEP_KEY) ?? 0)
  let found = 0
  while (cursor < top && Date.now() < deadline) {
    const end =
      one<{ h: number | null }>(
        db,
        `select max(height) as h from (
           select height from txn where height > ? order by height limit ${SWEEP_STEP})`,
        cursor,
      )?.h ?? top
    const candidates = all<TxnRow>(
      db,
      `select t.* from txn t
       where t.height > ? and t.height <= ?
         and t.kind in (${TxKind.Send}, ${TxKind.Burn})
         and not exists (select 1 from role where tx = t.hash)
         and (select count(*) from note where spent_tx = t.hash) = 2
       order by t.height, t.idx`,
      cursor,
      end,
    )
    const rows = candidates.flatMap((t) => {
      const s = sweepOf(db, t)
      return s ? [s] : []
    })
    transaction(db, () => {
      const insert = db.prepare(
        `insert into sweep (tx, height, time, kind, outputs,
           old_commitment, old_tx, old_age, fresh_commitment, fresh_tx, fresh_age,
           fresh_kind, old_value, old_min, old_max, fresh_value, fresh_min,
           fresh_max, burn_tx, burn_hops, burn_addr, burn_amount)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (tx) do nothing`,
      )
      for (const r of rows) {
        insert.run(
          r.tx,
          r.height,
          r.time,
          r.kind,
          r.outputs,
          r.old_commitment,
          r.old_tx,
          r.old_age,
          r.fresh_commitment,
          r.fresh_tx,
          r.fresh_age,
          r.fresh_kind,
          r.old_value,
          r.old_min,
          r.old_max,
          r.fresh_value,
          r.fresh_min,
          r.fresh_max,
          r.burn_tx,
          r.burn_hops,
          r.burn_addr,
          r.burn_amount,
        )
      }
      setSync(db, SWEEP_KEY, String(end))
    })
    found += rows.length
    cursor = end
  }
  if (found > 0) log('sweeps', { found, height: cursor })
}

/** The sweep a two-input transaction is, if it is one */
export function sweepOf(db: Db, t: TxnRow): SweepRow | undefined {
  const inputs = inputsOf(db, t.hash)
  const [a, b] = inputs
  if (inputs.length !== 2 || !a?.created_tx || !b?.created_tx) return undefined
  const ca = getTxn(db, a.created_tx)
  const cb = getTxn(db, b.created_tx)
  if (!ca || !cb) return undefined
  const [old, fresh, oldTx, freshTx] =
    t.time - ca.time >= t.time - cb.time ? [a, b, ca, cb] : [b, a, cb, ca]
  const oldAge = t.time - oldTx.time
  const freshAge = t.time - freshTx.time
  if (oldAge < SWEEP_OLD || freshAge > SWEEP_FRESH) return undefined
  const behindOld = ancestors(db, oldTx.hash, SWEEP_APART)
  for (const h of ancestors(db, freshTx.hash, SWEEP_APART)) {
    if (behindOld.has(h)) return undefined
  }
  const sub = collect(
    db,
    [t.hash],
    { backward: true, forward: false },
    SWEEP_BACK,
  )
  const bounds = inferWithBatches(db, withSideBranches(db, sub, SWEEP_SIDE))
  const bo = bounds.get(old.commitment)
  const bf = bounds.get(fresh.commitment)
  const burn = burnAhead(db, t)
  return {
    tx: t.hash,
    height: t.height,
    time: t.time,
    kind: t.kind,
    outputs: outputsOf(db, t.hash).length,
    old_commitment: old.commitment,
    old_tx: oldTx.hash,
    old_age: oldAge,
    fresh_commitment: fresh.commitment,
    fresh_tx: freshTx.hash,
    fresh_age: freshAge,
    fresh_kind: freshTx.kind,
    ...boundColumns('old', bo),
    ...boundColumns('fresh', bf),
    burn_tx: burn?.hash ?? null,
    burn_hops: burn?.hops ?? null,
    burn_addr: burn?.burn_addr ?? null,
    burn_amount: burn?.amount ?? null,
  }
}

function boundColumns<P extends 'old' | 'fresh'>(
  prefix: P,
  b: Bounds | undefined,
): Record<`${P}_value` | `${P}_max`, number | null> &
  Record<`${P}_min`, number> {
  return {
    [`${prefix}_value`]: b?.value ?? null,
    [`${prefix}_min`]: b?.value ?? b?.min ?? 0,
    [`${prefix}_max`]: b?.value ?? b?.max ?? null,
  } as Record<`${P}_value` | `${P}_max`, number | null> &
    Record<`${P}_min`, number>
}

/** The transactions up to `hops` back of one, itself included */
function ancestors(db: Db, hash: string, hops: number): Set<string> {
  const seen = new Set([hash])
  let frontier = [hash]
  for (let i = 0; i < hops && frontier.length > 0; i++) {
    const next: string[] = []
    for (const h of frontier) {
      for (const n of inputsOf(db, h)) {
        if (n.created_tx && !seen.has(n.created_tx)) {
          seen.add(n.created_tx)
          next.push(n.created_tx)
        }
      }
    }
    frontier = next
  }
  return seen
}

/**
 * The first withdrawal reached ahead of a transaction, breadth first; card
 * batches are Payy's own withdrawals and are not followed into
 */
function burnAhead(db: Db, t: TxnRow): (TxnRow & { hops: number }) | undefined {
  if (t.kind === TxKind.Burn) return { ...t, hops: 0 }
  const seen = new Set<string>()
  const queue = [{ hash: t.hash, hops: 0 }]
  // breadth first; the queue grows while it is iterated
  for (const { hash, hops } of queue) {
    for (const n of outputsOf(db, hash)) {
      if (!n.spent_tx || seen.has(n.spent_tx)) continue
      seen.add(n.spent_tx)
      if (seen.size > SWEEP_AHEAD) return undefined
      const s = getTxn(db, n.spent_tx)
      if (!s || roleOf(db, s.hash)) continue
      if (s.kind === TxKind.Burn) return { ...s, hops: hops + 1 }
      queue.push({ hash: s.hash, hops: hops + 1 })
    }
  }
  return undefined
}

// ---- burn shapes ---------------------------------------------------------

/**
 * Withdrawals outside card batches with one input, with and without
 * change: how many burn a note that a 1-in/1-out send made, and how long
 * before. Counted once a day; the query takes a while.
 */
export function deriveBurnShapes(db: Db): void {
  const stored = burnShapes(db)
  const now = Math.floor(Date.now() / 1000)
  if (stored && now - stored.computedAt < BURNS_TTL) return
  const started = Date.now()
  const card = CARD_SETTLEMENT.map(() => '?').join(', ')
  const rows = all<{
    outputs: number
    time: number
    amount: number
    ctime: number
    ckind: TxKind
    cin: number
    cout: number
  }>(
    db,
    `select (select count(*) from note where created_tx = b.hash) as outputs,
       b.time, b.amount, c.time as ctime, c.kind as ckind,
       (select count(*) from note where spent_tx = c.hash) as cin,
       (select count(*) from note where created_tx = c.hash) as cout
     from txn b join note n on n.spent_tx = b.hash
     join txn c on c.hash = n.created_tx
     where b.kind = ${TxKind.Burn} and b.burn_addr not in (${card})
       and (select count(*) from note where spent_tx = b.hash) = 1`,
    ...CARD_SETTLEMENT,
  )
  const shape = (outputs: number): BurnShape => {
    const own = rows.filter((r) => r.outputs === outputs)
    const gaps = own
      .filter((r) => r.ckind === TxKind.Send && r.cin === 1 && r.cout === 1)
      .map((r) => r.time - r.ctime)
      .sort((a, b) => a - b)
    return {
      count: own.length,
      amount: own.reduce((a, r) => a + r.amount, 0),
      afterRekey: gaps.length,
      medianGap: median(gaps),
      within10min: gaps.filter((g) => g <= 600).length,
    }
  }
  const result: KeyStats['burns'] = {
    computedAt: now,
    noChange: shape(0),
    withChange: shape(1),
  }
  setSync(db, BURNS_KEY, JSON.stringify(result))
  log('burn shapes', { rows: rows.length, ms: Date.now() - started })
}

function burnShapes(db: Db): KeyStats['burns'] | undefined {
  const value = getSync(db, BURNS_KEY)
  return value ? (JSON.parse(value) as KeyStats['burns']) : undefined
}

// ---- the summary ---------------------------------------------------------

const FIRST: FirstSpend[] = [
  'unspent',
  'rekey',
  'send',
  'card',
  'merge',
  'burn',
  'other',
]

export function keyStats(
  db: Db,
  now = Math.floor(Date.now() / 1000),
): KeyStats | undefined {
  const summary = migrationSummary(db)
  if (!summary) return undefined
  const rows = all<MigratedRow>(db, 'select * from migrated')
  const payouts = rows.filter((r) => r.change === 0)
  // classified so far; the rest wait for the sync
  const notes = payouts.flatMap((r) =>
    r.first ? [noteOf(r, r.first, now)] : [],
  )
  const first = Object.fromEntries(
    FIRST.map((f) => [f, heldStats(notes.filter((n) => n.first === f))]),
  ) as Record<FirstSpend, HeldStats>
  const spent = heldStats(notes.filter((n) => n.first !== 'unspent'))
  const s = one<{
    n: number
    d: number
    small: number
    sum: number
    open: number
    burn: number
  }>(
    db,
    `select count(*) as n, sum(fresh_kind = ${TxKind.Mint}) as d,
       sum(old_max is not null and old_max <= ${SMALL}) as small,
       sum(case when old_max <= ${SMALL} then old_max else 0 end) as sum,
       sum(old_max is null) as open, sum(burn_tx is not null) as burn
     from sweep`,
  )
  const ages = all<{ old_age: number }>(
    db,
    'select old_age from sweep order by old_age',
  ).map((r) => r.old_age)
  const examples = all<SweepRow>(
    db,
    `select * from sweep where old_max <= ${SMALL} and burn_tx is not null
     order by time desc limit ?`,
    EXAMPLES,
  ).map(sweepView)
  return {
    migration: {
      start: summary.start,
      end: summary.end,
      payouts: payouts.length,
      change: rows.length - payouts.length,
      deposited: summary.deposited,
      classified: notes.length,
      first,
      spent,
      burned: notes.reduce(
        (a, n) => a + (n.first === 'burn' ? (n.burnAmount ?? 0) : 0),
        0,
      ),
    },
    sweeps: {
      height: Number(getSync(db, SWEEP_KEY) ?? 0),
      count: s?.n ?? 0,
      withDeposit: s?.d ?? 0,
      small: s?.small ?? 0,
      smallSum: s?.sum ?? 0,
      open: s?.open ?? 0,
      intoBurn: s?.burn ?? 0,
      medianAge: median(ages),
      examples,
    },
    burns: burnShapes(db) ?? {
      computedAt: 0,
      noChange: EMPTY_SHAPE,
      withChange: EMPTY_SHAPE,
    },
  }
}

const EMPTY_SHAPE: BurnShape = {
  count: 0,
  amount: 0,
  afterRekey: 0,
  medianGap: 0,
  within10min: 0,
}

function noteOf(r: MigratedRow, first: FirstSpend, now: number): MigratedNote {
  return {
    commitment: r.commitment,
    createdTx: r.created_tx,
    createdTime: r.created_time,
    first,
    spentTx: r.spent_tx ?? undefined,
    held: (r.spent_time ?? now) - r.created_time,
    value: r.value ?? undefined,
    min: r.min ?? 0,
    max: r.max ?? undefined,
    burnAmount: r.burn_amount ?? undefined,
    burnAddr: r.burn_addr ?? undefined,
  }
}

/** The figures of a set of migrated notes; examples: known values first, then the longest held */
export function heldStats(notes: MigratedNote[]): HeldStats {
  const exact = notes.filter((n) => n.value !== undefined)
  const spent = notes.filter((n) => n.first !== 'unspent')
  const closed = notes.every((n) => n.max !== undefined)
  const examples = [...notes]
    .sort(
      (a, b) =>
        Number(b.value !== undefined) - Number(a.value !== undefined) ||
        b.held - a.held,
    )
    .slice(0, EXAMPLES)
  return {
    count: notes.length,
    medianHeld: median(notes.map((n) => n.held).sort((a, b) => a - b)),
    maxHeld: notes.reduce((a, n) => Math.max(a, n.held), 0),
    withinHour: spent.filter((n) => n.held <= 3600).length,
    withinDay: spent.filter((n) => n.held <= 86400).length,
    exact: exact.length,
    exactSum: exact.reduce((a, n) => a + (n.value ?? 0), 0),
    min: notes.reduce((a, n) => a + n.min, 0),
    max: closed ? notes.reduce((a, n) => a + (n.max ?? 0), 0) : undefined,
    examples,
  }
}

function sweepView(r: SweepRow): Sweep {
  return {
    tx: r.tx,
    time: r.time,
    kind: r.kind,
    outputs: r.outputs,
    old: {
      commitment: r.old_commitment,
      tx: r.old_tx,
      age: r.old_age,
      value: r.old_value ?? undefined,
      min: r.old_min,
      max: r.old_max ?? undefined,
    },
    fresh: {
      commitment: r.fresh_commitment,
      tx: r.fresh_tx,
      age: r.fresh_age,
      deposit: r.fresh_kind === TxKind.Mint,
    },
    ...(r.burn_tx &&
      r.burn_addr && {
        burn: {
          tx: r.burn_tx,
          hops: r.burn_hops ?? 0,
          recipient: r.burn_addr,
          label: labelOf(r.burn_addr),
          amount: r.burn_amount ?? 0,
        },
      }),
  }
}

/** The median of a sorted list, 0 when empty */
function median(sorted: number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
