import { USDC_DECIMALS } from './protocol'

/** Micro USDC as a decimal string with thousands separators */
export function usdc(amount: number): string {
  const [whole = '0', fraction = ''] = (amount / 10 ** USDC_DECIMALS)
    .toFixed(USDC_DECIMALS)
    .split('.')
  const decimals = fraction.replace(/0+$/, '')
  return `${Number(whole).toLocaleString('en-US')}${decimals ? `.${decimals}` : ''}`
}

/** Unix seconds as `YYYY-MM-DD HH:MM` in UTC */
export function date(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ')
}
