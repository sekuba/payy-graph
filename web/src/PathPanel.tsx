import { useState } from 'react'
import type {
  Deposit,
  Destination,
  Graph,
  Path,
  PathHop,
  Withdrawal,
} from '../../src/graph/types'
import { CHAINS, ORIGIN_CHAINS } from '../../src/protocol'
import { Address } from './Address'
import { BridgeText, originName } from './Bridge'
import {
  between,
  DUST,
  date,
  FRONTED,
  payyTxUrl,
  shortHex,
  usdc,
} from './format'

/** Deposits named as sources of a mixed history */
const NAMED_SOURCES = 3
/** Rows of one kind listed one by one before they are summed up */
const LISTED = 3

/**
 * A withdrawal's history as a statement: first the link it shows (where
 * the money came from, where it went), then what came in, what went out and
 * what is left, and the transactions behind it on request.
 */
export function PathPanel({ path }: { path: Path }) {
  const [steps, setSteps] = useState(false)
  const note = contextOf(path)
  return (
    <section className="card grid gap-3 p-3">
      <Link path={path} />
      <Statement path={path} />
      {note && (
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {note}
        </p>
      )}
      <div>
        <button
          type="button"
          className="toggle text-xs"
          onClick={() => setSteps((s) => !s)}
        >
          {steps ? 'hide' : 'show'} the {path.hops.length} transactions on Payy
        </button>
        {steps && <Steps path={path} />}
      </div>
    </section>
  )
}

// ---- the link ------------------------------------------------------------

/**
 * Where the withdrawal's money came from and where it went, side by side:
 * the deposit (or what can be said of the sources) and the withdrawal, with
 * the time and the number of transactions between them.
 */
function Link({ path }: { path: Path }) {
  const w = path.withdrawal
  const o = path.origin
  const { named } = splitSenders(path)
  const sources: React.ReactNode[] = []
  let start: number | undefined
  let from: string | undefined
  if (named.length > 0) {
    // who provably supplied part of it: one sender's deposits, or several
    start = named[0]?.first
    from = named[0]?.address
    for (const g of named) {
      const only =
        g.deposits === 1
          ? path.sources.find((d) => senderOf(d) === g.address)
          : undefined
      const whole = named.length === 1 && g.share.min === w.amount
      const share = whole ? undefined : between(g.share.min, g.share.max)
      sources.push(
        only ? (
          <DepositBox key={g.address} d={only} share={share} />
        ) : (
          <Box
            key={g.address}
            color="deposit"
            title={
              share
                ? `${share} from ${g.deposits} deposits of`
                : `${g.deposits} deposits`
            }
            amount={usdc(g.amount)}
          >
            by{' '}
            <Address
              address={g.address}
              explorer={g.chain ? ORIGIN_CHAINS[g.chain]?.explorer : undefined}
            />
            {g.chain ? ` on ${originName(g.chain)}` : ''}
            <br />
            {date(g.first).slice(0, 10)} – {date(g.last).slice(0, 10)}
          </Box>
        ),
      )
    }
  } else if (o.type === 'deposit' && path.sources.length <= 1) {
    start = o.deposit?.time ?? o.time
    from = o.deposit && senderOf(o.deposit)
    sources.push(
      o.deposit ? (
        <DepositBox key="d" d={o.deposit} />
      ) : (
        <Box key="d" color="deposit" title="Deposit" amount={usdc(o.amount)}>
          {date(o.time)} · L1 side not indexed yet
        </Box>
      ),
    )
  } else if (o.type === 'migration' && path.sources.length === 0) {
    start = o.time
    sources.push(
      <Box
        key="m"
        color="muted"
        title="Migrated balance"
        amount={
          o.value !== undefined
            ? usdc(o.value)
            : o.min
              ? `≥ ${usdc(o.min)}`
              : 'hidden'
        }
      >
        re-issued by Payy {date(o.time).slice(0, 10)}; not linked to the
        previous chain
      </Box>,
    )
  } else {
    const n = path.sources.length
    const open = path.sources.some((d) => d.share?.max === undefined)
    sources.push(
      <Box
        key="mix"
        color="muted"
        title="Mixed"
        amount={`${n}${open ? '+' : ''} deposit${n === 1 ? '' : 's'}${o.type === 'migration' ? ' and a migrated balance' : ''}`}
        unit=""
      >
        none of them provably supplied a cent of it
      </Box>,
    )
  }
  const same = from !== undefined && from === w.recipient.toLowerCase()
  const internal = path.hops.filter(
    (h) => h.kind !== 'deposit' && h.kind !== 'withdrawal',
  ).length
  return (
    <div className="link">
      <div className="grid gap-2">{sources}</div>
      <div className="link-arrow text-xs" style={{ color: 'var(--muted)' }}>
        <span>
          {[
            start !== undefined && `${duration(w.time - start)} later`,
            internal > 0 &&
              `${internal} transaction${internal === 1 ? '' : 's'}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {same && <span className="chip chip-strong">same address</span>}
      </div>
      <WithdrawalBox w={w} />
    </div>
  )
}

function Box({
  color,
  title,
  amount,
  unit = ' USDC',
  children,
}: {
  color: string
  title: string
  amount: string
  unit?: string
  children: React.ReactNode
}) {
  return (
    <div className="link-box" style={{ borderLeftColor: `var(--${color})` }}>
      <div className="text-xs" style={{ color: 'var(--muted)' }}>
        {title}
      </div>
      <div className="mono font-semibold">
        {amount}
        {unit}
      </div>
      <div className="text-xs" style={{ color: 'var(--ink-2)' }}>
        {children}
      </div>
    </div>
  )
}

function DepositBox({ d, share }: { d: Deposit; share?: string }) {
  const b = d.bridge
  return (
    <Box
      color="deposit"
      title={share ? `${share} from a deposit of` : 'Deposit'}
      amount={usdc(d.amount)}
    >
      {b ? (
        <BridgeText deposit={d} />
      ) : (
        <>
          from <Address address={d.depositor} chain={d.chain} l1Tx={d.l1Tx} />{' '}
          on {CHAINS[d.chain].name}
        </>
      )}
      <br />
      {date(d.time)}
    </Box>
  )
}

function WithdrawalBox({ w }: { w: Withdrawal }) {
  return (
    <Box color="withdrawal" title="Withdrawn" amount={usdc(w.amount)}>
      to <Address address={w.recipient} chain={w.chain} />
      {w.chain ? ` on ${CHAINS[w.chain].name}` : ' · pending'}
      {w.substituted && (
        <>
          {' · '}
          <span className="help" title={FRONTED}>
            paid early by Payy
          </span>
        </>
      )}
      <br />
      {date(w.time)}
    </Box>
  )
}

/** Who a deposit came from: the sender on the other chain when bridged */
function senderOf(d: Deposit): string {
  return (
    d.bridge?.funder?.address ??
    d.bridge?.depositor ??
    d.depositor
  ).toLowerCase()
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${m % 60} min`
  return `${Math.round(h / 24)} days`
}

// ---- the statement -------------------------------------------------------

interface Line {
  key: string
  amount: string
  what: React.ReactNode
}

/** What came in, what went out and what is left, as far as it is public */
function Statement({ path }: { path: Path }) {
  const o = path.origin
  const sourceOf = (hop: PathHop) =>
    path.sources.find((d) => d.txHash === hop.txHash)
  const ins: Line[] = []
  const outs: Line[] = []
  /** exact totals, undefined once something is only bounded */
  let inTotal: number | undefined = 0
  let outTotal: number | undefined = 0
  const addIn = (v: number | undefined) => {
    inTotal = inTotal === undefined || v === undefined ? undefined : inTotal + v
  }
  const addOut = (v: number | undefined) => {
    outTotal =
      outTotal === undefined || v === undefined ? undefined : outTotal + v
  }

  if (o.type === 'migration') {
    addIn(o.value)
    ins.push({
      key: 'migration',
      amount:
        o.value !== undefined
          ? usdc(o.value)
          : o.min
            ? `≥ ${usdc(o.min)}`
            : 'hidden',
      what: `migrated balance, ${date(o.time).slice(0, 10)}`,
    })
  }
  const deposits = path.hops.filter((h) => h.kind === 'deposit')
  for (const h of deposits) addIn(h.amount)
  if (deposits.length <= LISTED) {
    for (const h of deposits) {
      const d = sourceOf(h)
      ins.push({
        key: h.txHash,
        amount: usdc(h.amount ?? 0),
        what: d ? (
          <>
            deposit <SourceText d={d} />
          </>
        ) : (
          `deposit, ${date(h.time)}`
        ),
      })
    }
  } else {
    const who = new Set(
      deposits.map((h) => {
        const d = sourceOf(h)
        return d ? senderOf(d) : h.depositor
      }),
    )
    const [one] = who
    ins.push({
      key: 'deposits',
      amount: usdc(deposits.reduce((a, h) => a + (h.amount ?? 0), 0)),
      what: (
        <>
          {deposits.length} deposits
          {who.size === 1 && one ? (
            <>
              {' '}
              by <Address address={one} />
            </>
          ) : (
            ` by ${who.size} senders`
          )}
          , {span(deposits)}
        </>
      ),
    })
  }
  for (const m of path.merged) {
    addIn(m.value)
    const w = m.from.withdrawals[0]
    const d = m.from.deposits[0]
    ins.push({
      key: `m${m.txHash}`,
      amount: between(m.value ?? m.min, m.value ?? m.max),
      what: w ? (
        <>
          left over from the history that withdrew {usdc(w.amount)} USDC to{' '}
          <Address address={w.recipient} chain={w.chain} /> on{' '}
          {date(w.time).slice(0, 10)}
        </>
      ) : d ? (
        <>
          from the history of a deposit of {usdc(d.amount)} by{' '}
          <Address address={d.depositor} chain={d.chain} />
        </>
      ) : (
        'from another history'
      ),
    })
  }

  if (o.type === 'merge' || o.type === 'limit') {
    inTotal = undefined
    const { named, rest, bounded, others } = splitSenders(path)
    for (const g of named) {
      ins.push({
        key: g.address,
        amount: between(g.share.min, g.share.max),
        what: (
          <>
            of {g.deposits === 1 ? 'a deposit' : `${g.deposits} deposits`} of{' '}
            {usdc(g.amount)} by <Address address={g.address} />
            {g.chain ? ` on ${originName(g.chain)}` : ''}
          </>
        ),
      })
    }
    if (rest.length > 0) {
      const n = rest.reduce((a, g) => a + g.deposits, 0)
      ins.push({
        key: 'rest',
        amount: bounded ? `≤ ${usdc(others)}` : 'mixed',
        what: `from ${n}${bounded ? '' : '+'} other deposit${n === 1 ? '' : 's'} by ${rest.length} sender${rest.length === 1 ? '' : 's'}${o.type === 'merge' ? `, merged in on ${date(o.time).slice(0, 10)}` : ''}`,
      })
    }
  }
  const withdrawals = path.hops.filter((h) => h.kind === 'withdrawal')
  for (const h of withdrawals) addOut(h.amount)
  if (withdrawals.length <= LISTED) {
    for (const h of withdrawals) {
      outs.push({
        key: h.txHash,
        amount: usdc(h.amount ?? 0),
        what: (
          <>
            withdrawn to{' '}
            {h.recipient && <Address address={h.recipient} chain={h.chain} />},{' '}
            {date(h.time)}
          </>
        ),
      })
    }
  } else {
    outs.push({
      key: 'withdrawals',
      amount: usdc(withdrawals.reduce((a, h) => a + (h.amount ?? 0), 0)),
      what: `${withdrawals.length} withdrawals, ${span(withdrawals)}`,
    })
  }
  const card = path.hops.filter((h) => h.out?.destination.type === 'card')
  const paid = path.hops.filter(
    (h) =>
      h.kind === 'send' &&
      h.out &&
      h.out.destination.type !== 'card' &&
      h.out.destination.type !== 'unspent',
  )
  for (const [hops, one, many] of [
    [card, 'card payment', 'card payments'],
    [paid, 'payment to another wallet', 'payments to other wallets'],
  ] as const) {
    if (hops.length === 0) continue
    const exact = hops.every((h) => h.out?.value !== undefined)
    const lo = hops.reduce((a, h) => a + (h.out?.value ?? h.out?.min ?? 0), 0)
    addOut(exact ? lo : undefined)
    const recurring = hops.filter((h) => h.recurring).length
    outs.push({
      key: one,
      // an upper bound on hidden amounts says little here
      amount: exact ? usdc(lo) : lo > 0 ? `≥ ${usdc(lo)}` : 'hidden',
      what: `${hops.length === 1 ? one : `${hops.length} ${many}`}, ${span(hops)}${recurring ? ` · ${recurring} monthly` : ''}`,
    })
  }

  // what is left in notes nobody has spent yet
  const unspent = path.hops.filter((h) => h.out?.destination.type === 'unspent')
  let left: string | undefined
  if (inTotal !== undefined && outTotal !== undefined) {
    left = usdc(Math.max(0, inTotal - outTotal))
  } else if (unspent.length > 0) {
    const exact = unspent.every((h) => h.out?.value !== undefined)
    const lo = unspent.reduce(
      (a, h) => a + (h.out?.value ?? h.out?.min ?? 0),
      0,
    )
    const hi = unspent.every((h) => h.out?.max !== undefined)
      ? unspent.reduce((a, h) => a + (h.out?.value ?? h.out?.max ?? 0), 0)
      : undefined
    left = exact
      ? usdc(lo)
      : hi !== undefined && hi <= path.withdrawal.amount
        ? between(lo, hi)
        : 'hidden'
  }

  return (
    <table className="flow stack text-sm">
      <tbody>
        <Lines label="in" color="var(--deposit)" lines={ins} />
        <Lines label="out" color="var(--withdrawal)" lines={outs} />
        {left !== undefined && unspent.length > 0 && (
          <Lines
            label="left"
            color="var(--muted)"
            lines={[
              {
                key: 'left',
                amount: left,
                what: `in ${unspent.length} unspent note${unspent.length === 1 ? '' : 's'}, the wallet's or a recipient's`,
              },
            ]}
          />
        )}
      </tbody>
    </table>
  )
}

function Lines({
  label,
  color,
  lines,
}: {
  label: string
  color: string
  lines: Line[]
}) {
  return lines.map((line, i) => (
    <tr key={line.key}>
      <td className="flow-label" style={{ color }}>
        {i === 0 ? label : ''}
      </td>
      <td className="mono whitespace-nowrap pr-3 text-right">{line.amount}</td>
      <td className="wide" style={{ color: 'var(--ink-2)' }}>
        {line.what}
      </td>
    </tr>
  ))
}

/** A deposit's origin in a few words: its sender, and its chain if bridged */
function SourceText({ d }: { d: Deposit }) {
  return d.bridge ? (
    <>
      <BridgeText deposit={d} />, {date(d.time)}
    </>
  ) : (
    <>
      from <Address address={d.depositor} chain={d.chain} l1Tx={d.l1Tx} />,{' '}
      {date(d.time)}
    </>
  )
}

function span(hops: { time: number }[]): string {
  const day = (t: number) => date(t).slice(0, 10)
  const a = hops[0]?.time
  const b = hops[hops.length - 1]?.time
  if (a === undefined || b === undefined) return ''
  return day(a) === day(b) ? day(a) : `${day(a)} – ${day(b)}`
}

// ---- context -------------------------------------------------------------

/** A sentence where the statement needs one: the migration, or a mix */
function contextOf(path: Path): React.ReactNode {
  const o = path.origin
  if (o.type === 'migration') {
    const d = o.distribution
    return (
      <>
        The history starts with a note from the migration of{' '}
        {date(o.time).slice(0, 10)}, when Payy re-issued the balances of its
        previous chain
        {d && (
          <>
            : {d.released.toLocaleString('en-US')} notes paid out from{' '}
            {usdc(d.deposited)} USDC of treasury deposits
          </>
        )}
        . Which old wallet got which note was decided off-chain, so nothing
        links this wallet to its history before.
      </>
    )
  }
  if (o.type === 'merge') {
    const truncated = path.sources.some((d) => d.share?.max === undefined)
    return (
      <>
        On {date(o.time)} the wallet merged two notes with separate histories,
        so the funds are mixed: USDC in a transaction is interchangeable, and
        only amounts can tell how much came from where.
        {truncated &&
          ' The history behind it is larger than the walk, so only lower bounds are shown.'}
      </>
    )
  }
  if (o.type === 'limit') {
    return `The history is longer than ${path.hops.length} transactions and is shown from ${date(path.hops[0]?.time ?? 0)}.`
  }
  return undefined
}

/**
 * The senders whose deposits together must have supplied at least a cent
 * of the withdrawal (the first few), the rest, and a bound on the rest
 */
function splitSenders(path: Path) {
  const named = path.senders
    .filter((g) => g.share.min >= DUST)
    .slice(0, NAMED_SOURCES)
  const rest = path.senders.filter((g) => !named.includes(g))
  const covered = named.reduce((a, g) => a + g.share.min, 0)
  const bounded = rest.every((g) => g.share.max !== undefined)
  const others = Math.min(
    path.withdrawal.amount - covered,
    rest.reduce((a, g) => a + (g.share.max ?? 0), 0),
  )
  return { named, rest, bounded, others }
}

// ---- the transactions ----------------------------------------------------

function Steps({ path }: { path: Path }) {
  return (
    <table className="stack mt-2 w-full text-left text-xs">
      <thead style={{ color: 'var(--muted)' }}>
        <tr>
          <th className="py-1 font-normal">Time</th>
          <th className="py-1 font-normal">Event</th>
          <th className="py-1 font-normal">Detail</th>
          <th className="py-1 text-right font-normal">USDC</th>
          <th className="py-1 font-normal">Payy tx</th>
        </tr>
      </thead>
      <tbody>
        {path.hops.map((hop) => (
          <Row
            key={hop.txHash}
            hop={hop}
            merged={path.merged.find((m) => m.txHash === hop.txHash)}
          />
        ))}
      </tbody>
    </table>
  )
}

function Row({
  hop,
  merged,
}: {
  hop: PathHop
  /** a note from another history merged in here */
  merged?: Path['merged'][number]
}) {
  const [event, detail] = describe(hop, merged)
  return (
    <tr className="row hairline border-t">
      <td className="mono whitespace-nowrap py-1 pr-2">{date(hop.time)}</td>
      <td className="whitespace-nowrap py-1 pr-2">
        <span
          className="dot"
          style={{ background: `var(--${colorOf(hop)})` }}
        />
        {event}
        {hop.recurring && <span className="chip ml-1">monthly</span>}
      </td>
      <td className="wide py-1 pr-2">{detail}</td>
      <td className="mono whitespace-nowrap py-1 text-right">
        {merged && !hop.out
          ? between(merged.value ?? merged.min, merged.value ?? merged.max)
          : amountOf(hop)}
      </td>
      <td className="mono py-1 pl-2" data-label="Payy">
        <a href={payyTxUrl(hop.txHash)} target="_blank" rel="noreferrer">
          {shortHex(hop.txHash, 4)}
        </a>
      </td>
    </tr>
  )
}

/**
 * What a transaction did for this history. A proof consumes up to two notes
 * and creates up to two; which of them stayed with the wallet follows from
 * which ones it spent again.
 */
function describe(
  hop: PathHop,
  merged: Path['merged'][number] | undefined,
): [string, React.ReactNode] {
  const muted = (s: string) => (
    <span style={{ color: 'var(--muted)' }}>{s}</span>
  )
  if (hop.kind === 'deposit' || hop.kind === 'withdrawal') {
    return [
      hop.kind === 'deposit' ? 'Deposit' : 'Withdrawal',
      <Counterparty key="c" hop={hop} />,
    ]
  }
  if (hop.out?.destination.type === 'card') {
    return ['Card payment', <DestinationText key="d" d={hop.out.destination} />]
  }
  if (merged && !hop.out) {
    return ['Merged in', muted('a note from another history, under a cent')]
  }
  if (hop.out?.destination.type === 'unspent') {
    return ['Split', muted('one note continues, the other is unspent')]
  }
  if (hop.out) {
    return ['Payment', <DestinationText key="d" d={hop.out.destination} />]
  }
  if (hop.inputs === 2) return ['Merge', muted('two of its own notes into one')]
  if (hop.outputs === 2) return ['Split', muted('one note into two, both kept')]
  return ['Send', muted('to itself')]
}

function colorOf(hop: PathHop): string {
  if (hop.kind === 'deposit') return 'deposit'
  if (hop.kind === 'withdrawal') return 'withdrawal'
  return hop.out?.destination.type === 'card' ? 'card' : 'send'
}

function amountOf(hop: PathHop): string {
  if (hop.amount !== undefined) return usdc(hop.amount)
  const out = hop.out
  if (!out) return ''
  return between(out.value ?? out.min, out.value ?? out.max)
}

function Counterparty({ hop }: { hop: PathHop }) {
  if (hop.kind === 'deposit') {
    return hop.depositor && hop.chain ? (
      <span>
        from{' '}
        <Address address={hop.depositor} chain={hop.chain} l1Tx={hop.l1Tx} />
      </span>
    ) : (
      <span style={{ color: 'var(--muted)' }}>deposit not indexed</span>
    )
  }
  return (
    <span>
      {hop.recipient && (
        <>
          to <Address address={hop.recipient} chain={hop.chain} />
        </>
      )}
      {hop.out && (
        <span className="ml-2" style={{ color: 'var(--muted)' }}>
          change: <DestinationText d={hop.out.destination} />
        </span>
      )}
    </span>
  )
}

function DestinationText({ d }: { d: Destination }) {
  switch (d.type) {
    case 'card':
      return (
        <span style={{ color: 'var(--ink-2)' }}>
          settled in a batch of {d.batch.notes} payments,{' '}
          <span className="mono">{usdc(d.batch.amount)}</span> withdrawn{' '}
          {date(d.batch.time)}
        </span>
      )
    case 'withdrawn':
      return (
        <span>
          withdrawn {date(d.time)} to{' '}
          <Address address={d.recipient} chain={d.chain} />
        </span>
      )
    case 'collected': {
      const top = d.recipients[0]
      if (!top) return null
      const more = d.recipients.length - 1
      return (
        <span>
          merged by other wallets, paid out to <Address address={top.address} />
          {more > 0 ? ` and ${more} more` : ''}
        </span>
      )
    }
    case 'circulating':
      return <span style={{ color: 'var(--muted)' }}>still on Payy</span>
    default:
      return <span style={{ color: 'var(--muted)' }}>unspent</span>
  }
}

// ---- a deposit -----------------------------------------------------------

/**
 * The mirror of a withdrawal's panel for a deposit: where its money went,
 * recipient by recipient, as far as the notes bound it
 */
export function DepositPanel({ graph, mint }: { graph: Graph; mint: string }) {
  const d = graph.deposits.find((x) => x.txHash === mint)
  if (!d) return null
  const recipients = graph.recipients ?? []
  const named = recipients
    .filter((r) => r.share.min >= DUST)
    .slice(0, NAMED_SOURCES)
  const spread = graph.spread
  const from = senderOf(d)
  const same = named.some((r) => r.address === from)
  // nothing bounded: one line instead of a column of question marks
  const unbounded =
    spread?.truncated === true && !recipients.some((r) => r.share.min >= DUST)
  const lines: Line[] = (unbounded ? [] : recipients.slice(0, LISTED + 2)).map(
    (r) => ({
      key: r.address,
      amount: between(r.share.min, r.share.max),
      what: (
        <>
          {r.withdrawals === 1
            ? 'of a withdrawal of'
            : `of ${r.withdrawals} withdrawals of`}{' '}
          {usdc(r.amount)} to <Address address={r.address} chain={r.chain} />,{' '}
          {span([{ time: r.first }, { time: r.last }])}
        </>
      ),
    }),
  )
  if (unbounded && recipients.length > 0) {
    const n = recipients.reduce((a, r) => a + r.withdrawals, 0)
    lines.push({
      key: 'mixed',
      amount: 'mixed',
      what: `${n}+ withdrawals to ${recipients.length}+ recipients ahead of it in this view`,
    })
  }
  const more = unbounded ? 0 : recipients.length - lines.length
  if (more > 0) {
    lines.push({
      key: 'more',
      amount: '',
      what: `and ${more} more recipient${more === 1 ? '' : 's'}, each a smaller share`,
    })
  }
  if (spread?.card !== undefined && spread.card > 0) {
    lines.push({
      key: 'card',
      amount: `≤ ${usdc(spread.card)}`,
      what: 'paid with the card',
    })
  }
  if (spread?.unspent !== undefined && spread.unspent > 0) {
    lines.push({
      key: 'unspent',
      amount: `≤ ${usdc(spread.unspent)}`,
      what: 'still on Payy, in unspent notes',
    })
  }
  return (
    <section className="card grid gap-3 p-3">
      <div className="link">
        <DepositBox d={d} />
        <div className="link-arrow text-xs" style={{ color: 'var(--muted)' }}>
          <span>
            {named[0] ? `${duration(named[0].first - d.time)} later` : ''}
          </span>
          {same && <span className="chip chip-strong">same address</span>}
        </div>
        <div className="grid gap-2">
          {named.length > 0 ? (
            named.map((r) => (
              <Box
                key={r.address}
                color="withdrawal"
                title={
                  r.share.min >= r.amount
                    ? r.withdrawals === 1
                      ? 'Withdrawn'
                      : `${r.withdrawals} withdrawals`
                    : `${between(r.share.min, r.share.max)} of it in ${r.withdrawals === 1 ? 'a withdrawal' : `${r.withdrawals} withdrawals`} of`
                }
                amount={usdc(r.amount)}
              >
                to <Address address={r.address} chain={r.chain} />
                <br />
                {span([{ time: r.first }, { time: r.last }])}
              </Box>
            ))
          ) : (
            <Box
              color="muted"
              title={recipients.length > 0 ? 'Mixed' : 'Not withdrawn'}
              amount={
                recipients.length > 0
                  ? `${recipients.length}${spread?.truncated ? '+' : ''} recipients`
                  : 'no withdrawal yet'
              }
              unit=""
            >
              {recipients.length > 0
                ? 'none of them provably got a cent of it'
                : 'in this view'}
            </Box>
          )}
        </div>
      </div>
      {lines.length > 0 && (
        <table className="flow stack text-sm">
          <tbody>
            <Lines label="out" color="var(--withdrawal)" lines={lines} />
          </tbody>
        </table>
      )}
      {spread?.truncated && (
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          More transactions follow this deposit than the view holds, so only
          lower bounds are shown: what the rest of the network cannot have
          supplied.
        </p>
      )}
    </section>
  )
}
