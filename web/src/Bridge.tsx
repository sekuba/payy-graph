import type { Bridged, Deposit } from '../../src/graph/types'
import { ORIGIN_CHAINS } from '../../src/protocol'
import { Address } from './Address'
import { date, usdc } from './format'

export function originName(chain: number): string {
  return ORIGIN_CHAINS[chain]?.name ?? `chain ${chain}`
}

/**
 * Where a bridged deposit came from, in one line: the origin chain and who
 * paid the address that bridged it there (or that address, when nobody
 * paid it just before). The whole route is in the tooltip.
 */
export function BridgeText({ deposit }: { deposit: Deposit }) {
  const b = deposit.bridge
  if (!b) return null
  const explorer = ORIGIN_CHAINS[b.chain]?.explorer
  const source = b.funder?.address ?? b.depositor
  return (
    <span className="help" title={route(deposit, b)}>
      bridged from {originName(b.chain)}
      {' · '}
      {b.funder ? 'sent by ' : 'by '}
      <Address
        address={source}
        explorer={explorer}
        l1Tx={b.funder?.tx ?? b.originTx}
      />
    </span>
  )
}

/** The route of a bridged deposit, step by step, for tooltips */
function route(d: Deposit, b: Bridged): string {
  const chain = originName(b.chain)
  const steps: string[] = []
  if (b.funder) {
    steps.push(
      `${b.funder.address} paid ${b.funder.amount !== undefined ? `${usdc(b.funder.amount)} ${b.funder.symbol} ` : ''}to ${b.depositor} on ${chain}, ${date(b.funder.time)}${b.originTime !== undefined ? `, ${b.originTime - b.funder.time} s before it bridged` : ''}`,
    )
  }
  steps.push(
    `${b.depositor} deposited into ${b.via} on ${chain}${b.originTime !== undefined ? `, ${date(b.originTime)}` : ''}`,
  )
  steps.push(
    `a ${b.via} relayer paid exactly ${usdc(d.amount)} USDC to ${d.depositor} (fill ${b.fillTx})`,
  )
  steps.push(`${d.depositor} deposited it into Payy, ${date(d.time)}`)
  return steps.join('\n')
}

/**
 * Who paid a deposit address that did not come through a bridge, just
 * before it deposited; through a router, the wallet that swapped
 */
export function FundingText({ deposit }: { deposit: Deposit }) {
  const f = deposit.funding
  if (!f) return null
  return (
    <span
      className="help"
      title={`${f.via ? `${f.via} (a contract, e.g. a swap router) sent the USDC to ${deposit.depositor} in a transaction sent by ${f.address}` : `${f.address} sent the USDC to ${deposit.depositor}`} shortly before it deposited (tx ${f.tx})`}
    >
      paid in by{' '}
      <Address address={f.address} chain={deposit.chain} l1Tx={f.tx} />
      {f.via ? ' via a contract' : ''}
    </span>
  )
}

/**
 * The caveat on a group that relies on who paid in: whoever paid a user's
 * Payy address is taken to be that user, which a payment alone does not
 * prove (a friend can pay you too). Services are left out of it.
 */
export function OwnerNote({
  addresses,
  root,
}: {
  addresses: string[]
  root: string
}) {
  const others = addresses.filter((a) => a !== root)
  return (
    <span
      className="help"
      style={{ color: 'var(--muted)' }}
      title={`Grouped with ${root} because that wallet paid ${others.length ? others.join(', ') : 'these addresses'} before they deposited or bridged. That usually means it owns them, but a payment alone does not prove it. Wallets that paid many different users (exchanges, routers) are never used for this.`}
    >
      grouped by who paid in
    </span>
  )
}
