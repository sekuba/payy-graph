import { CHAINS, type ChainId, PAYY_EXPLORER_URL } from '../../src/protocol'

export { date, usdc } from '../../src/format'

export function shortHex(hex: string, chars = 4): string {
  const h = hex.startsWith('0x') ? hex : `0x${hex}`
  return `${h.slice(0, 2 + chars)}…${h.slice(-chars)}`
}

export function l1TxUrl(chain: ChainId, tx: string): string {
  return `${CHAINS[chain].explorer}/tx/${tx}`
}

export function l1AddressUrl(chain: ChainId, address: string): string {
  return `${CHAINS[chain].explorer}/address/${address}`
}

export function payyTxUrl(hash: string): string {
  return `${PAYY_EXPLORER_URL}/transactions/${hash}`
}

/** What a fronted withdrawal is, for tooltips */
export const FRONTED =
  "Paid out early by Payy's burn substitutor from its own funds, before the burn was settled on L1; the settlement refunded the substitutor later."
