import {
  CHAINS,
  type ChainId,
  PAYY_EXPLORER_URL,
  USDC_DECIMALS,
} from '../../src/protocol'

export function usdc(amount: number): string {
  const [whole = '0', fraction = ''] = (amount / 10 ** USDC_DECIMALS)
    .toFixed(USDC_DECIMALS)
    .split('.')
  const decimals = fraction.replace(/0+$/, '')
  return `${Number(whole).toLocaleString('en-US')}${decimals ? `.${decimals}` : ''}`
}

export function shortHex(hex: string, chars = 4): string {
  const h = hex.startsWith('0x') ? hex : `0x${hex}`
  return `${h.slice(0, 2 + chars)}…${h.slice(-chars)}`
}

export function date(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ')
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
