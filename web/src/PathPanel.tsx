import type { Destination, Path, PathHop } from '../../src/graph/types'
import { CHAINS, type ChainId } from '../../src/protocol'
import {
  date,
  l1AddressUrl,
  l1TxUrl,
  payyTxUrl,
  shortHex,
  usdc,
} from './format'

/**
 * A withdrawal's history in words and a table: where the funds came from and
 * every note the wallet released on the way, with where each one ended up.
 */
export function PathPanel({ path }: { path: Path }) {
  return (
    <section className="card p-3">
      <div className="mb-2 flex items-baseline gap-3">
        <span className="mono">
          {usdc(path.withdrawal.amount)} USDC to{' '}
          {shortHex(path.withdrawal.recipient, 6)}
        </span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {date(path.withdrawal.time)}
        </span>
      </div>
      <div className="mb-3 text-sm">
        <Origin path={path} />
      </div>
      <table className="w-full text-left text-xs">
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
          {path.hops.map((hop) => (
            <tr key={hop.txHash} className="row hairline border-t">
              <td className="mono py-1">{date(hop.time)}</td>
              <td className="py-1">{eventOf(hop)}</td>
              <td className="py-1">
                <Counterparty hop={hop} />
              </td>
              <td className="mono py-1 text-right">{amountOf(hop)}</td>
              <td className="mono py-1">
                <a
                  href={payyTxUrl(hop.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortHex(hop.txHash, 6)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
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
            label={o.deposit.label}
            chain={o.deposit.chain}
          />{' '}
          on {CHAINS[o.deposit.chain].name}, {date(o.deposit.time)}.
        </span>
      ) : (
        <span>
          Funded by a deposit of {usdc(o.amount)} USDC on {date(o.time)}; its L1
          side is not indexed yet.
        </span>
      )
    case 'migration':
      return (
        <span>
          Received {date(o.time)} in the migration distribution, a Payy hub
          funded that evening by {usdc(o.treasury.amount)} USDC of treasury
          deposits. History before the migration is on the old chain and not
          visible here.
        </span>
      )
    case 'merge':
      return (
        <span>
          Consolidated from two notes on {date(o.time)}; both histories are in
          the graph below.
        </span>
      )
    default:
      return (
        <span>
          Path longer than {path.hops.length} transactions
          {first ? `, shown from ${date(first.time)}` : ''}.
        </span>
      )
  }
}

function eventOf(hop: PathHop): string {
  if (hop.kind === 'deposit') return 'Deposited'
  if (hop.kind === 'withdrawal') return 'Withdrawn'
  return 'Sent'
}

function amountOf(hop: PathHop): string {
  if (hop.amount !== undefined) return usdc(hop.amount)
  const out = hop.out
  if (!out) return ''
  if (out.value !== undefined) return usdc(out.value)
  if (out.max === undefined) return out.min > 0 ? `≥ ${usdc(out.min)}` : ''
  return out.min > 0
    ? `${usdc(out.min)} to ${usdc(out.max)}`
    : `≤ ${usdc(out.max)}`
}

function Counterparty({ hop }: { hop: PathHop }) {
  if (hop.kind === 'deposit') {
    return hop.depositor && hop.chain ? (
      <Address
        address={hop.depositor}
        label={hop.label}
        chain={hop.chain}
        l1Tx={hop.l1Tx}
      />
    ) : (
      <span style={{ color: 'var(--muted)' }}>deposit not indexed</span>
    )
  }
  if (hop.kind === 'withdrawal') {
    return (
      <span>
        {hop.recipient && (
          <Address
            address={hop.recipient}
            label={hop.label}
            chain={hop.chain}
          />
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
    <span style={{ color: 'var(--muted)' }}>kept (split or merge)</span>
  )
}

function DestinationText({ d }: { d: Destination }) {
  switch (d.type) {
    case 'withdrawn':
      return (
        <span>
          withdrawn {date(d.time)} to{' '}
          <Address address={d.recipient} label={d.label} chain={d.chain} />
        </span>
      )
    case 'collected': {
      const top = d.recipients[0]
      if (!top) return null
      const more = d.recipients.length - 1
      return (
        <span>
          collected, paid out to{' '}
          <Address address={top.address} label={top.label} />
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

function Address({
  address,
  label,
  chain,
  l1Tx,
}: {
  address: string
  label?: string
  chain?: ChainId
  l1Tx?: string
}) {
  const text = label ?? shortHex(address, 6)
  const href = chain
    ? l1Tx
      ? l1TxUrl(chain, l1Tx)
      : l1AddressUrl(chain, address)
    : undefined
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={label ? 'chip' : 'mono'}
    >
      {text}
    </a>
  ) : (
    <span className={label ? 'chip' : 'mono'}>{text}</span>
  )
}
