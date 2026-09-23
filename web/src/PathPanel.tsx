import { useState } from 'react'
import type { Destination, Path, PathHop } from '../../src/graph/types'
import { CHAINS } from '../../src/protocol'
import { Address } from './Address'
import { date, FRONTED, payyTxUrl, shortHex, usdc } from './format'

/** Rows of a long history shown before "show all" */
const INITIAL_ROWS = 12

/**
 * A withdrawal's history: a one-line summary of what came in and what went
 * out, where the funds came from, and every note the wallet released on the
 * way with where each one ended up.
 */
export function PathPanel({ path }: { path: Path }) {
  const [all, setAll] = useState(false)
  const w = path.withdrawal
  const rows =
    all || path.hops.length <= INITIAL_ROWS + 2
      ? path.hops
      : [
          ...path.hops.slice(0, INITIAL_ROWS / 2),
          ...path.hops.slice(-INITIAL_ROWS / 2),
        ]
  const hidden = path.hops.length - rows.length
  return (
    <section className="card p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <span>
          <span className="mono font-semibold">{usdc(w.amount)} USDC</span>{' '}
          withdrawn to <Address address={w.recipient} chain={w.chain} />
        </span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {date(w.time)}
          {w.chain ? ` · ${CHAINS[w.chain].name}` : ' · pending'}
          {w.substituted && (
            <>
              {' · '}
              <span className="help" title={FRONTED}>
                paid early by Payy
              </span>
            </>
          )}
        </span>
      </div>
      <Flow path={path} />
      <p className="my-3 text-sm" style={{ color: 'var(--ink-2)' }}>
        <Origin path={path} />
      </p>
      <table className="stack w-full text-left text-xs">
        <thead style={{ color: 'var(--muted)' }}>
          <tr>
            <th className="py-1 font-normal">Time</th>
            <th className="py-1 font-normal">Event</th>
            <th className="py-1 font-normal">Counterparty</th>
            <th className="py-1 text-right font-normal">USDC</th>
            <th className="py-1 font-normal">Payy tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((hop, i) => (
            <Row
              key={hop.txHash}
              hop={hop}
              gap={
                hidden > 0 && i === INITIAL_ROWS / 2 ? (
                  <button
                    type="button"
                    className="toggle"
                    onClick={() => setAll(true)}
                  >
                    show {hidden} more
                  </button>
                ) : undefined
              }
            />
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Row({ hop, gap }: { hop: PathHop; gap?: React.ReactNode }) {
  return (
    <>
      {gap && (
        <tr className="hairline border-t">
          <td colSpan={5} className="py-1 text-center">
            {gap}
          </td>
        </tr>
      )}
      <tr className="row hairline border-t">
        <td className="mono whitespace-nowrap py-1 pr-2">{date(hop.time)}</td>
        <td className="whitespace-nowrap py-1 pr-2">
          <span
            className="dot"
            style={{ background: `var(--${colorOf(hop)})` }}
          />
          {eventOf(hop)}
          {hop.recurring && <span className="chip ml-1">monthly</span>}
        </td>
        <td className="wide py-1 pr-2">
          <Counterparty hop={hop} />
        </td>
        <td className="mono whitespace-nowrap py-1 text-right">
          {amountOf(hop)}
        </td>
        <td className="mono py-1 pl-2" data-label="Payy">
          <a href={payyTxUrl(hop.txHash)} target="_blank" rel="noreferrer">
            {shortHex(hop.txHash, 4)}
          </a>
        </td>
      </tr>
    </>
  )
}

/**
 * What came in and what went out along this history, one line per kind,
 * with the dates they span
 */
function Flow({ path }: { path: Path }) {
  const o = path.origin
  const deposits = path.hops.filter((h) => h.kind === 'deposit')
  const withdrawals = path.hops.filter((h) => h.kind === 'withdrawal')
  const card = path.hops.filter((h) => h.out?.destination.type === 'card')
  const exact = card.filter((h) => h.out?.value !== undefined)
  const recurring = card.filter((h) => h.recurring)
  const transfers = path.hops.filter(
    (h) =>
      h.kind === 'send' &&
      h.out &&
      h.out.destination.type !== 'card' &&
      h.out.destination.type !== 'unspent',
  )
  const sum = (hops: PathHop[]) =>
    hops.reduce((a, h) => a + (h.amount ?? h.out?.value ?? 0), 0)
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  const ins: Item[] = []
  if (o.type === 'migration') {
    ins.push({
      key: 'migration',
      what: 'Migrated balance',
      amount:
        o.value !== undefined
          ? usdc(o.value)
          : o.min
            ? `≥ ${usdc(o.min)}`
            : 'hidden',
      note:
        o.value === undefined && o.min
          ? 'exact amount hidden; the minimum follows from what was spent'
          : undefined,
      hops: [{ time: o.time }],
    })
  }
  if (o.type === 'merge') {
    ins.push({
      key: 'merge',
      what: 'Notes from another history',
      hops: [{ time: o.time }],
    })
  }
  if (deposits.length > 0) {
    ins.push({
      key: 'deposits',
      what: count(deposits.length, 'deposit'),
      amount: usdc(sum(deposits)),
      hops: deposits,
    })
  }
  const outs: Item[] = []
  if (card.length > 0) {
    outs.push({
      key: 'card',
      what: count(card.length, 'card payment'),
      amount:
        exact.length === card.length
          ? usdc(sum(exact))
          : exact.length > 0
            ? `${usdc(sum(exact))} known`
            : 'hidden',
      note: [
        recurring.length > 0 && `${recurring.length} monthly`,
        exact.length < card.length && 'each at most its batch total',
      ]
        .filter(Boolean)
        .join(', '),
      hops: card,
    })
  }
  if (transfers.length > 0) {
    outs.push({
      key: 'transfers',
      what: count(transfers.length, 'transfer'),
      note: 'to other wallets',
      hops: transfers,
    })
  }
  if (withdrawals.length > 0) {
    outs.push({
      key: 'withdrawals',
      what: count(withdrawals.length, 'withdrawal'),
      amount: usdc(sum(withdrawals)),
      hops: withdrawals,
    })
  }
  return (
    <table className="flow stack text-sm">
      <tbody>
        <FlowRows label="in" color="var(--deposit)" items={ins} />
        <FlowRows label="out" color="var(--withdrawal)" items={outs} />
      </tbody>
    </table>
  )
}

interface Item {
  key: string
  what: string
  /** USDC, or why there is no figure */
  amount?: string
  note?: string
  hops: { time: number }[]
}

function FlowRows({
  label,
  color,
  items,
}: {
  label: string
  color: string
  items: Item[]
}) {
  if (items.length === 0) return null
  return items.map((item, i) => {
    const first = item.hops[0]?.time
    const last = item.hops[item.hops.length - 1]?.time
    const day = (t: number) => date(t).slice(0, 10)
    return (
      <tr key={item.key}>
        <td className="flow-label" style={{ color }}>
          {i === 0 ? label : ''}
        </td>
        <td className="whitespace-nowrap pr-3">{item.what}</td>
        <td className="mono whitespace-nowrap pr-3 text-right">
          {item.amount}
        </td>
        <td
          className="mono whitespace-nowrap pr-3 text-xs"
          style={{ color: 'var(--muted)' }}
        >
          {first !== undefined &&
            (last !== undefined && day(last) !== day(first)
              ? `${day(first)} – ${day(last)}`
              : day(first))}
        </td>
        <td className="text-xs" style={{ color: 'var(--muted)' }}>
          {item.note}
        </td>
      </tr>
    )
  })
}

function Origin({ path }: { path: Path }) {
  const o = path.origin
  const first = path.hops[0]
  switch (o.type) {
    case 'deposit':
      return o.deposit ? (
        <span>
          Funded by a deposit of {usdc(o.deposit.amount)} USDC from{' '}
          <Address
            address={o.deposit.depositor}
            chain={o.deposit.chain}
            l1Tx={o.deposit.l1Tx}
          />{' '}
          on {CHAINS[o.deposit.chain].name}, {date(o.deposit.time)}.
        </span>
      ) : (
        <span>
          Funded by a deposit of {usdc(o.amount)} USDC on {date(o.time)}; its L1
          side is not indexed yet.
        </span>
      )
    case 'migration': {
      const d = o.distribution
      return (
        <span>
          The history starts on {date(o.time)} with a note from the migration
          distribution, which re-issued the balances of the previous Payy chain
          {d && (
            <>
              : {d.released.toLocaleString('en-US')} notes paid out by Payy
              between {date(d.start)} and {date(d.end)}, funded by{' '}
              {usdc(d.deposited)} USDC of treasury deposits
            </>
          )}
          . Which old wallet received which note was decided off-chain, so
          nothing links this wallet to its history before the migration.
        </span>
      )
    }
    case 'merge':
      return (
        <span>
          Before {date(o.time)} the funds came from two separate notes, merged
          then; both histories are in the graph below.
        </span>
      )
    default:
      return (
        <span>
          History longer than {path.hops.length} transactions
          {first ? `, shown from ${date(first.time)}` : ''}.
        </span>
      )
  }
}

function colorOf(hop: PathHop): string {
  if (hop.kind === 'deposit') return 'deposit'
  if (hop.kind === 'withdrawal') return 'withdrawal'
  return hop.out?.destination.type === 'card' ? 'card' : 'send'
}

function eventOf(hop: PathHop): string {
  if (hop.kind === 'deposit') return 'Deposit'
  if (hop.kind === 'withdrawal') return 'Withdrawal'
  if (hop.out?.destination.type === 'card') return 'Card payment'
  return hop.out ? 'Transfer' : 'Split or merge'
}

function amountOf(hop: PathHop): string {
  if (hop.amount !== undefined) return usdc(hop.amount)
  const out = hop.out
  if (!out) return ''
  if (out.value !== undefined) return usdc(out.value)
  if (out.max === undefined) return out.min > 0 ? `≥ ${usdc(out.min)}` : '?'
  return out.min > 0
    ? `${usdc(out.min)} – ${usdc(out.max)}`
    : `≤ ${usdc(out.max)}`
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
  if (hop.kind === 'withdrawal') {
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
  return hop.out ? (
    <DestinationText d={hop.out.destination} />
  ) : (
    <span style={{ color: 'var(--muted)' }}>kept by the wallet</span>
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
