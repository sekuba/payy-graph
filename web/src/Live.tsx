import { useEffect, useState } from 'react'
import type {
  AmountMatch,
  LiveEvent,
  LiveStats,
  NamedAddress,
  Trace,
} from '../../src/graph/types'
import { CHAINS, type ChainId } from '../../src/protocol'
import { Address } from './Address'
import { api } from './api'
import { date, l1TxUrl, usdc } from './format'
import { seedNames } from './names'

const TABS = [
  ['all', 'all activity', 'newest deposits, withdrawals and card batches'],
  [
    'named',
    'named activity',
    'only addresses with a label or an ENS or GNS name',
  ],
  [
    'addresses',
    'named addresses',
    'every address with a label or an ENS or GNS name that deposited or withdrew',
  ],
] as const

/** How often the live view refreshes */
const REFRESH_MS = 20_000

/**
 * The page without a query: live figures and the newest deposits,
 * withdrawals and card batches, each withdrawal with where its funds came
 * from. Definitions are in the hovers.
 */
export function Live({ onSelect }: { onSelect: (query: string) => void }) {
  const [stats, setStats] = useState<LiveStats>()
  const [events, setEvents] = useState<LiveEvent[]>()
  const [tab, setTab] = useState<'all' | 'named' | 'addresses'>('all')
  const named = tab === 'named'
  const [now, setNow] = useState(() => Date.now() / 1000)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      api
        .stats()
        .then((s) => !cancelled && setStats(s))
        .catch(() => undefined)
      api
        .live(named)
        .then((l) => {
          if (cancelled) return
          seedNames(l.names)
          setEvents(l.events)
          setNow(Date.now() / 1000)
        })
        .catch(() => undefined)
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [named])

  // relative times keep moving between refreshes
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 5_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      {stats && <Stats stats={stats} now={now} />}
      <section className="card p-3">
        <div className="mb-2 flex flex-wrap gap-1 text-xs">
          {TABS.map(([id, text, title]) => (
            <button
              key={id}
              type="button"
              className={`toggle ${tab === id ? 'on' : ''}`}
              onClick={() => setTab(id)}
              title={title}
            >
              {text}
            </button>
          ))}
        </div>
        {tab === 'addresses' ? (
          <NamedTable onSelect={onSelect} />
        ) : (
          events && <Feed events={events} now={now} onSelect={onSelect} />
        )}
      </section>
    </>
  )
}

/** The labelled and named addresses, latest activity first */
function NamedTable({ onSelect }: { onSelect: (query: string) => void }) {
  const [rows, setRows] = useState<NamedAddress[]>()
  const [kind, setKind] = useState<'all' | 'names' | 'labels'>('all')
  useEffect(() => {
    api
      .named()
      .then((r) => {
        seedNames(
          Object.fromEntries(
            r.flatMap((a) =>
              a.ens || a.gns ? [[a.address, { ens: a.ens, gns: a.gns }]] : [],
            ),
          ),
        )
        setRows(r)
      })
      .catch(() => undefined)
  }, [])
  if (!rows) return null
  const shown = rows.filter((r) =>
    kind === 'names' ? r.ens || r.gns : kind === 'labels' ? r.label : true,
  )
  const day = (t: number) => date(t).slice(0, 10)
  return (
    <>
      <div className="mb-2 flex flex-wrap items-baseline gap-1 text-xs">
        {(
          [
            ['all', 'all'],
            ['names', 'ENS / GNS'],
            ['labels', 'labels'],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            type="button"
            className={`toggle ${kind === id ? 'on' : ''}`}
            onClick={() => setKind(id)}
          >
            {text}
          </button>
        ))}
        <span className="ml-2" style={{ color: 'var(--muted)' }}>
          {shown.length.toLocaleString('en-US')} addresses
        </span>
      </div>
      <table className="stack w-full text-left text-xs">
        <thead style={{ color: 'var(--muted)' }}>
          <tr>
            <th className="py-1 font-normal">Address</th>
            <th className="py-1 font-normal">Name</th>
            <th className="py-1 text-right font-normal">Deposits</th>
            <th className="py-1 text-right font-normal">Withdrawals</th>
            <th className="py-1 font-normal">Last active</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr
              key={r.address}
              className="row hairline cursor-pointer border-t"
              onClick={() => onSelect(r.address)}
            >
              <td className="py-1">
                <Address address={r.address} noName />
              </td>
              <td className="name py-1">
                {[r.ens, r.gns].filter(Boolean).join(' · ')}
              </td>
              <td
                className="mono whitespace-nowrap py-1 text-right"
                data-label="deposits"
              >
                {totals(r.deposits)}
              </td>
              <td
                className="mono whitespace-nowrap py-1 text-right"
                data-label="withdrawals"
              >
                {totals(r.withdrawals)}
              </td>
              <td
                className="mono whitespace-nowrap py-1"
                data-label="last"
                title={`active ${day(r.first)} – ${day(r.last)}`}
              >
                {day(r.last)}
                {day(r.first) !== day(r.last) && (
                  <span style={{ color: 'var(--muted)' }}>
                    {' '}
                    · since {day(r.first)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function totals(t: { count: number; amount: number }): React.ReactNode {
  if (t.count === 0) return <span style={{ color: 'var(--muted)' }}>–</span>
  return (
    <>
      {t.count.toLocaleString('en-US')}{' '}
      <span style={{ color: 'var(--muted)' }}>· {whole(t.amount)} USDC</span>
    </>
  )
}

function Stats({ stats, now }: { stats: LiveStats; now: number }) {
  const [range, setRange] = useState<'week' | 'all'>('week')
  const t = stats.traces[range]
  const d = stats.day
  const share = t.count ? Math.round((100 * t.single) / t.count) : undefined
  const settled = (
    Object.entries(stats.settled) as [
      ChainId,
      { height: number; time: number },
    ][]
  ).sort((a, b) => b[1].height - a[1].height)[0]
  return (
    <section className="card grid gap-1 p-3 text-sm">
      <div className="stats">
        <Stat label="height" title="latest Payy block">
          {stats.payyHeight?.toLocaleString('en-US') ?? '–'}
          {stats.payyTime && <Muted> {ago(now - stats.payyTime)} ago</Muted>}
        </Stat>
        {settled && (
          <Stat
            label="settled"
            title={`latest Payy height whose state root was posted to ${CHAINS[settled[0]].name}; withdrawals above it are paid early by Payy or wait`}
          >
            {settled[1].height.toLocaleString('en-US')}
            <Muted>
              {' '}
              on {CHAINS[settled[0]].name}, {ago(now - settled[1].time)} ago
            </Muted>
          </Stat>
        )}
        <Stat
          label="transactions"
          title="all Payy transactions since 2025-08-28"
        >
          {stats.txns.toLocaleString('en-US')}
        </Stat>
        {Object.entries(stats.locked)
          .filter(([, amount]) => (amount ?? 0) >= 1e6)
          .map(([chain, amount]) => (
            <Stat
              key={chain}
              label={`USDC in rollup · ${CHAINS[chain as ChainId].name}`}
              title="USDC balance of the Payy Rollup contract"
            >
              {whole(amount ?? 0)}
            </Stat>
          ))}
      </div>
      <div className="stats">
        <Stat label="24h deposits" title="deposits on L1 in the last 24 hours">
          {d.deposits.count} <Muted>· {whole(d.deposits.amount)} USDC</Muted>
        </Stat>
        <Stat
          label="24h withdrawals"
          title="withdrawals in the last 24 hours, not counting card batches"
        >
          {d.withdrawals.count}{' '}
          <Muted>· {whole(d.withdrawals.amount)} USDC</Muted>
        </Stat>
        <Stat
          label="24h card"
          title="card payments merged into the card batches withdrawn in the last 24 hours"
        >
          {d.card.payments} payments{' '}
          <Muted>
            · {d.card.batches} batches · {whole(d.card.amount)} USDC
          </Muted>
        </Stat>
      </div>
      <div className="stats">
        <Stat
          label="traced to one deposit"
          title="withdrawals whose note descends from exactly one deposit, through the wallet's own transactions, with no second history merged in"
        >
          {share !== undefined ? `${share}%` : '–'}{' '}
          <Muted>
            ({t.single.toLocaleString('en-US')} of{' '}
            {t.count.toLocaleString('en-US')})
          </Muted>
        </Stat>
        <Stat
          label="depositors behind a withdrawal"
          title="median number of distinct addresses whose deposits are in a withdrawal's history (walking back up to 400 transactions, so a minimum for long histories)"
        >
          {t.medianDepositors ?? '–'}
        </Stat>
        <Stat
          label="hops to nearest deposit"
          title="median number of transactions between a withdrawal and the nearest deposit in its history"
        >
          {t.medianNearest ?? '–'}
        </Stat>
        <span className="flex gap-1 text-xs">
          {(['week', 'all'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={`toggle ${range === r ? 'on' : ''}`}
              onClick={() => setRange(r)}
            >
              {r === 'week' ? '7d' : 'all'}
            </button>
          ))}
        </span>
      </div>
      <div className="stats">
        <Stat
          label="amount matches, 30d"
          title="withdrawals in the last 30 days whose exact amount (not a whole number of USDC) was deposited in the 7 days before"
        >
          {stats.matches.matched.toLocaleString('en-US')}{' '}
          <Muted>of {stats.matches.withdrawals.toLocaleString('en-US')}</Muted>
        </Stat>
        <Stat
          label="reused recipients"
          title="withdrawal recipients that received more than one withdrawal, which links those withdrawals to each other"
        >
          {stats.reuse.recipients
            ? `${Math.round((100 * stats.reuse.reused) / stats.reuse.recipients)}%`
            : '–'}{' '}
          <Muted>
            ({stats.reuse.reused.toLocaleString('en-US')} of{' '}
            {stats.reuse.recipients.toLocaleString('en-US')})
          </Muted>
        </Stat>
      </div>
    </section>
  )
}

function Stat({
  label,
  title,
  children,
}: {
  label: string
  title: string
  children: React.ReactNode
}) {
  return (
    <span title={title} className="help-quiet">
      <span className="stat-label">{label}</span>{' '}
      <span className="mono">{children}</span>
    </span>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--muted)' }}>{children}</span>
}

function Feed({
  events,
  now,
  onSelect,
}: {
  events: LiveEvent[]
  now: number
  onSelect: (query: string) => void
}) {
  if (events.length === 0) {
    return <div style={{ color: 'var(--muted)' }}>–</div>
  }
  return (
    <table className="stack w-full text-left text-xs">
      <tbody>
        {events.map((e) => (
          <Row key={keyOf(e)} event={e} now={now} onSelect={onSelect} />
        ))}
      </tbody>
    </table>
  )
}

function keyOf(e: LiveEvent): string {
  if (e.type === 'withdrawal') return e.withdrawal.txHash
  if (e.type === 'deposit') return `${e.deposit.chain}${e.deposit.mintHash}`
  return e.batch.burnTx
}

function Row({
  event: e,
  now,
  onSelect,
}: {
  event: LiveEvent
  now: number
  onSelect: (query: string) => void
}) {
  const time = timeOf(e)
  const cells =
    e.type === 'withdrawal' ? (
      <>
        <Kind color="withdrawal">withdrawal</Kind>
        <td className="mono py-1 pr-2 text-right">
          {usdc(e.withdrawal.amount)}
        </td>
        <td className="py-1 pr-2">
          →{' '}
          <Address
            address={e.withdrawal.recipient}
            chain={e.withdrawal.chain}
          />
          {e.reuse && e.reuse.of > 1 && (
            <span
              className="chip chip-strong ml-1"
              title={`withdrawal ${e.reuse.nth} of ${e.reuse.of} to this address; the address links them to each other`}
            >
              {e.reuse.nth} of {e.reuse.of}
            </span>
          )}
        </td>
        <td className="wide py-1">
          {e.match && !sameDeposit(e) && (
            <AmountMatchText match={e.match} time={e.withdrawal.time} />
          )}
          <Source
            trace={e.trace}
            time={e.withdrawal.time}
            sameAmount={sameDeposit(e)}
          />
        </td>
      </>
    ) : e.type === 'deposit' ? (
      <>
        <Kind color="deposit">deposit</Kind>
        <td className="mono py-1 pr-2 text-right">{usdc(e.deposit.amount)}</td>
        <td className="py-1 pr-2">
          ← <Address address={e.deposit.depositor} chain={e.deposit.chain} />
        </td>
        <td className="py-1" style={{ color: 'var(--muted)' }}>
          <a
            href={l1TxUrl(e.deposit.chain, e.deposit.l1Tx)}
            target="_blank"
            rel="noreferrer"
            onClick={(ev) => ev.stopPropagation()}
          >
            {CHAINS[e.deposit.chain].name} tx
          </a>
        </td>
      </>
    ) : (
      <>
        <Kind color="card">card batch</Kind>
        <td className="mono py-1 pr-2 text-right">{usdc(e.batch.amount)}</td>
        <td className="py-1 pr-2">
          → <Address address={e.batch.recipient} chain={e.batch.chain} />
        </td>
        <td className="py-1" style={{ color: 'var(--muted)' }}>
          {e.batch.notes.toLocaleString('en-US')} payments merged since{' '}
          {ago(now - e.batch.firstTime)} ago
        </td>
      </>
    )
  const query =
    e.type === 'withdrawal'
      ? e.withdrawal.txHash
      : e.type === 'deposit'
        ? e.deposit.txHash || e.deposit.depositor
        : undefined
  return (
    <tr
      className={`row hairline border-t ${query ? 'cursor-pointer' : ''}`}
      onClick={() => query && onSelect(query)}
    >
      <td className="mono whitespace-nowrap py-1 pr-2" title={date(time)}>
        {ago(now - time)}
      </td>
      {cells}
    </tr>
  )
}

function Kind({
  color,
  children,
}: {
  color: string
  children: React.ReactNode
}) {
  return (
    <td className="whitespace-nowrap py-1 pr-2">
      <span className="dot" style={{ background: `var(--${color})` }} />
      {children}
    </td>
  )
}

/** The amount match is the deposit the trace found anyway */
function sameDeposit(e: Extract<LiveEvent, { type: 'withdrawal' }>): boolean {
  return (
    e.match?.count === 1 &&
    e.match.depositor === e.trace?.source?.depositor &&
    e.match.time === e.trace.source.time
  )
}

/** A deposit of exactly the withdrawn amount shortly before */
function AmountMatchText({
  match: m,
  time,
}: {
  match: AmountMatch
  time: number
}) {
  return (
    <span className="mr-3">
      <span
        className="chip chip-strong"
        title={`${m.count === 1 ? 'a deposit' : `${m.count} deposits`} of exactly this amount in the 7 days before; the amount alone pairs them`}
      >
        = {m.count === 1 ? 'deposit' : `${m.count} deposits`}
      </span>{' '}
      ← <Address address={m.depositor} chain={m.chain} />
      <span style={{ color: 'var(--muted)' }}>
        {' '}
        · {ago(time - m.time)} earlier
      </span>
    </span>
  )
}

/** Where a withdrawal's funds came from, in one line */
function Source({
  trace: t,
  time,
  sameAmount,
}: {
  trace?: Trace
  time: number
  /** the source deposit also has exactly the withdrawn amount */
  sameAmount?: boolean
}) {
  if (!t) {
    return (
      <span style={{ color: 'var(--muted)' }} title="not traced yet">
        …
      </span>
    )
  }
  if (t.source) {
    return (
      <span>
        <span
          className="chip chip-strong"
          title="the withdrawn note descends from this one deposit only"
        >
          1 deposit
        </span>{' '}
        ← <Address address={t.source.depositor} chain={t.source.chain} />
        <span style={{ color: 'var(--muted)' }}>
          {' '}
          · {usdc(t.source.amount)} · {plural(t.source.hops, 'hop')} ·{' '}
          {ago(time - t.source.time)} earlier
        </span>
        {sameAmount && (
          <span
            className="chip chip-strong ml-1"
            title="this deposit also has exactly the withdrawn amount"
          >
            same amount
          </span>
        )}
      </span>
    )
  }
  if (t.origin === 'migration') {
    return (
      <span
        style={{ color: 'var(--muted)' }}
        title="the history begins with a note from the 2025-09-12 migration of the previous Payy chain"
      >
        migrated balance
      </span>
    )
  }
  if (t.depositors === 0) {
    return <span style={{ color: 'var(--muted)' }}>no deposit found</span>
  }
  const n = `${t.depositors}${t.truncated ? '+' : ''}`
  return (
    <span
      title={`deposits from ${n} distinct addresses are in this withdrawal's history${t.truncated ? ' (walked back 400 transactions)' : ''}; the nearest is ${plural(t.nearest ?? 0, 'transaction')} away`}
    >
      {n} depositor{t.depositors === 1 && !t.truncated ? '' : 's'}
      <span style={{ color: 'var(--muted)' }}>
        {' '}
        · nearest {plural(t.nearest ?? 0, 'hop')}
      </span>
    </span>
  )
}

function timeOf(e: LiveEvent): number {
  if (e.type === 'withdrawal') return e.withdrawal.time
  if (e.type === 'deposit') return e.deposit.time
  return e.batch.time
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** 42s, 5m, 3h, 2d */
function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 2 * 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Micro USDC as whole USDC with separators */
function whole(amount: number): string {
  return Math.round(amount / 1e6).toLocaleString('en-US')
}
