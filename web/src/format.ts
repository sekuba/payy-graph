import type { ChainId } from '../../src/graph/types'

export const USDC_DECIMALS = 6

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

const EXPLORERS: Record<ChainId, string> = {
  ethereum: 'https://etherscan.io',
  polygon: 'https://polygonscan.com',
}

export function l1TxUrl(chain: ChainId, tx: string): string {
  return `${EXPLORERS[chain]}/tx/${tx}`
}

export function l1AddressUrl(chain: ChainId, address: string): string {
  return `${EXPLORERS[chain]}/address/${address}`
}

export function payyTxUrl(hash: string): string {
  return `https://payy.network/explorer/transactions/${hash}`
}

export const CHAIN_NAME: Record<ChainId, string> = {
  ethereum: 'Ethereum',
  polygon: 'Polygon',
}
