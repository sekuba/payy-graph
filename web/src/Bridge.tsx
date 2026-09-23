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
