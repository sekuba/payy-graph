import { all, type Db, one } from '../db'
import { PUBLIC_LABELS } from '../labels.generated'
import {
  CARD_SETTLEMENT,
  type ChainId,
  KNOWN_ADDRESSES,
  labelOf,
  TxKind,
} from '../protocol'
import type { TxnRow } from './closure'
import { bridgeOf, cardBatchOf, withdrawalOf } from './queries'
import { fromRow, traceOf } from './traces'
import type {
  AmountMatch,
  LiveEvent,
  LiveStats,
  NamedAddress,
  Names,
} from './types'

const DAY = 24 * 3600
/** how far back a deposit of the same amount counts as a match */
export const MATCH_WINDOW = 7 * DAY

/**
 * The newest deposits, withdrawals and card batches, newest first. With
 * `named`, only deposits and withdrawals whose address has a label or an
 * ENS or GNS name.
 */
export function liveEvents(
  db: Db,
  options: { named: boolean; limit: number },
): { events: LiveEvent[]; names: Names } {
  const { named, limit } = options
  const card = CARD_SETTLEMENT.map(() => '?').join(', ')
  const labelled = [
    ...Object.keys(KNOWN_ADDRESSES),
    ...Object.keys(PUBLIC_LABELS),
  ]
  const isNamed = (column: string) =>
    `(name.ens is not null or name.gns is not null or ${column} in (${labelled.map(() => '?').join(', ')}))`

  const burns = all<TxnRow>(
    db,
    `select txn.* from txn left join name on name.address = txn.burn_addr
     where txn.kind = ${TxKind.Burn} and txn.burn_addr not in (${card})
     ${named ? `and ${isNamed('txn.burn_addr')}` : ''}
     order by txn.height desc limit ?`,
    ...CARD_SETTLEMENT,
    ...(named ? labelled : []),
    limit,
  )
  const deposits = all<DepositRow>(
    db,
    `select deposit.* from deposit left join name on name.address = deposit.depositor
     ${named ? `where ${isNamed('deposit.depositor')}` : ''}
     order by deposit.time desc limit ?`,
    ...(named ? labelled : []),
    limit,
  )
  const batches = named
    ? []
    : all<{ burn_tx: string }>(
        db,
        'select burn_tx from card_batch order by height desc limit ?',
        Math.ceil(limit / 4),
      )

  const mintOf = db.prepare(
    `select hash from txn where kind = ${TxKind.Mint} and msg_hash = ?`,
  )
  const events: (LiveEvent & { time: number })[] = [
    ...burns.map((b) => ({
      type: 'withdrawal' as const,
      time: b.time,
      withdrawal: withdrawalOf(db, b),
      trace: traceOf(db, b.hash),
      match: amountMatch(db, b),
      reuse: reuseOf(db, b),
    })),
    ...deposits.map((d) => ({
      type: 'deposit' as const,
      time: d.time,
      deposit: {
        mintHash: d.mint_hash,
        txHash:
          (mintOf.get(d.mint_hash) as { hash: string } | undefined)?.hash ?? '',
        chain: d.chain,
        l1Tx: d.tx,
        time: d.time,
        depositor: d.depositor,
        label: labelOf(d.depositor),
        amount: d.amount,
        bridge: bridgeOf(db, d.chain, d.mint_hash),
      },
    })),
    ...batches.flatMap((b) => {
      const batch = cardBatchOf(db, b.burn_tx)
      return batch ? [{ type: 'card' as const, time: batch.time, batch }] : []
    }),
  ]
  const newest = events
    .sort((a, b) => b.time - a.time)
    .slice(0, limit)
    .map(({ time: _, ...e }) => e as LiveEvent)

  // names already resolved, so the page shows them without asking
  const addresses = newest.flatMap((e) =>
    e.type === 'withdrawal'
      ? [
          e.withdrawal.recipient,
          ...(e.trace?.source ? [e.trace.source.depositor] : []),
          ...(e.match ? [e.match.depositor] : []),
        ]
      : e.type === 'deposit'
        ? [
            e.deposit.depositor,
            ...(e.deposit.bridge?.funder
              ? [e.deposit.bridge.funder.address]
              : []),
          ]
        : [],
  )
  return { events: newest, names: namesOf(db, addresses) }
}

/**
 * Deposits of exactly the withdrawn amount in the MATCH_WINDOW before the
 * withdrawal. Only for amounts with a fraction of a USDC: whole amounts are
 * too common to single anything out.
 */
export function amountMatch(db: Db, burn: TxnRow): AmountMatch | undefined {
  if (burn.amount % 1_000_000 === 0) return undefined
  const rows = all<{ depositor: string; chain: ChainId; time: number }>(
    db,
    `select depositor, chain, time from deposit
     where amount = ? and time between ? and ? order by time desc`,
    burn.amount,
    burn.time - MATCH_WINDOW,
    burn.time,
  )
  const latest = rows[0]
  return latest && { count: rows.length, ...latest }
}

/** The position of a withdrawal among all withdrawals to its recipient */
function reuseOf(db: Db, burn: TxnRow): { nth: number; of: number } {
  const count = (where: string, ...params: (string | number)[]) =>
    one<{ n: number }>(
      db,
      `select count(*) as n from txn where kind = ${TxKind.Burn} and burn_addr = ? ${where}`,
      burn.burn_addr ?? '',
      ...params,
    )?.n ?? 0
  return {
    nth: count(
      'and (height < ? or (height = ? and idx <= ?))',
      burn.height,
      burn.height,
      burn.idx,
    ),
    of: count(''),
  }
}

interface DepositRow {
  chain: ChainId
  mint_hash: string
  tx: string
  time: number
  depositor: string
  amount: number
}

function namesOf(db: Db, addresses: string[]): Names {
  const unique = [...new Set(addresses)]
  if (unique.length === 0) return {}
  const names: Names = {}
  for (const r of all<{
    address: string
    ens: string | null
    gns: string | null
  }>(
    db,
    `select * from name where address in (${unique.map(() => '?').join(', ')})
     and (ens is not null or gns is not null)`,
    ...unique,
  )) {
    names[r.address] = {
      ...(r.ens && { ens: r.ens }),
      ...(r.gns && { gns: r.gns }),
    }
  }
  return names
}

/** Live figures from the index; `locked` is filled in by the server from L1 */
export function liveStats(db: Db, now = Math.floor(Date.now() / 1000)) {
  const head = one<{ height: number; time: number }>(
    db,
    'select height, time from txn order by height desc limit 1',
  )
  const settled: LiveStats['settled'] = {}
  for (const r of all<{ chain: ChainId; height: number; time: number }>(
    db,
    `select s.chain, s.height, s.time from settlement s
     join (select chain, max(height) as h from settlement group by chain) m
       on m.chain = s.chain and m.h = s.height`,
  )) {
    settled[r.chain] = { height: r.height, time: r.time }
  }
  const card = CARD_SETTLEMENT.map(() => '?').join(', ')
  const dayHeight = heightAt(db, now - DAY)
  const deposits = one<{ n: number; s: number | null }>(
    db,
    'select count(*) as n, sum(amount) as s from deposit where time > ?',
    now - DAY,
  )
  const withdrawals = one<{ n: number; s: number | null }>(
    db,
    `select count(*) as n, sum(amount) as s from txn
     where height > ? and kind = ${TxKind.Burn} and burn_addr not in (${card})`,
    dayHeight,
    ...CARD_SETTLEMENT,
  )
  const batches = one<{ n: number; p: number | null; s: number | null }>(
    db,
    `select count(*) as n, sum(notes) as p, sum(amount) as s
     from card_batch where time > ?`,
    now - DAY,
  )
  const month = all<TxnRow>(
    db,
    `select * from txn where height > ? and kind = ${TxKind.Burn}
     and burn_addr not in (${card})`,
    heightAt(db, now - 30 * DAY),
    ...CARD_SETTLEMENT,
  )
  const reuse = one<{ n: number; r: number }>(
    db,
    `select count(*) as n, sum(k > 1) as r from (
       select count(*) as k from txn where kind = ${TxKind.Burn}
       and burn_addr not in (${card}) group by burn_addr)`,
    ...CARD_SETTLEMENT,
  )
  const stats: Omit<LiveStats, 'locked'> = {
    payyHeight: head?.height,
    payyTime: head?.time,
    txns: one<{ n: number }>(db, 'select count(*) as n from txn')?.n ?? 0,
    settled,
    day: {
      deposits: { count: deposits?.n ?? 0, amount: deposits?.s ?? 0 },
      withdrawals: { count: withdrawals?.n ?? 0, amount: withdrawals?.s ?? 0 },
      card: {
        payments: batches?.p ?? 0,
        batches: batches?.n ?? 0,
        amount: batches?.s ?? 0,
      },
    },
    matches: {
      withdrawals: month.length,
      matched: month.filter((b) => amountMatch(db, b)).length,
    },
    reuse: { recipients: reuse?.n ?? 0, reused: reuse?.r ?? 0 },
    traces: {
      week: traceSummary(db, heightAt(db, now - 7 * DAY)),
      all: traceSummary(db, -1),
    },
  }
  return stats
}

function traceSummary(db: Db, fromHeight: number): LiveStats['traces']['all'] {
  const rows = all<Parameters<typeof fromRow>[0]>(
    db,
    'select * from trace where height > ?',
    fromHeight,
  ).map(fromRow)
  const found = rows.filter((t) => t.depositors > 0)
  return {
    count: rows.length,
    single: rows.filter((t) => t.origin === 'deposit').length,
    medianDepositors: median(found.map((t) => t.depositors)),
    medianNearest: median(found.flatMap((t) => t.nearest ?? [])),
  }
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * The first height at or after `time`, by binary search over the height
 * index (block times only grow with height)
 */
export function heightAt(db: Db, time: number): number {
  const at = db.prepare(
    'select height, time from txn where height >= ? order by height limit 1',
  )
  let lo = 0
  let hi =
    one<{ h: number | null }>(db, 'select max(height) as h from txn')?.h ?? 0
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const row = at.get(mid) as { height: number; time: number } | undefined
    if (!row) break
    if (row.time < time) lo = row.height + 1
    else hi = mid
  }
  return lo
}

/**
 * Every depositor and withdrawal recipient with a label (Payy's own
 * included) or an ENS or GNS name, with its totals, latest activity first
 */
export function namedAddresses(db: Db): NamedAddress[] {
  const names = new Map(
    all<{ address: string; ens: string | null; gns: string | null }>(
      db,
      'select * from name where ens is not null or gns is not null',
    ).map((r) => [r.address, r]),
  )
  const candidates = new Set([
    ...names.keys(),
    ...Object.keys(KNOWN_ADDRESSES),
    ...Object.keys(PUBLIC_LABELS),
  ])
  const deposits = db.prepare(
    `select count(*) as n, sum(amount) as s, min(time) as f, max(time) as l
     from deposit where depositor = ?`,
  )
  const withdrawals = db.prepare(
    `select count(*) as n, sum(amount) as s, min(time) as f, max(time) as l
     from txn where kind = ${TxKind.Burn} and burn_addr = ?`,
  )
  type Totals = {
    n: number
    s: number | null
    f: number | null
    l: number | null
  }
  const result: NamedAddress[] = []
  for (const address of candidates) {
    const d = deposits.get(address) as Totals
    const w = withdrawals.get(address) as Totals
    if (d.n === 0 && w.n === 0) continue
    const name = names.get(address)
    const times = [d.f, d.l, w.f, w.l].filter((t): t is number => t !== null)
    result.push({
      address,
      label: labelOf(address),
      ...(name?.ens && { ens: name.ens }),
      ...(name?.gns && { gns: name.gns }),
      deposits: { count: d.n, amount: d.s ?? 0 },
      withdrawals: { count: w.n, amount: w.s ?? 0 },
      first: Math.min(...times),
      last: Math.max(...times),
    })
  }
  return result.sort((a, b) => b.last - a.last)
}
