import { useState } from 'react'
import type { Deposit, Withdrawal } from '../../src/graph/types'
import { CHAINS } from '../../src/protocol'
import { Address } from './Address'
import { date, l1TxUrl, payyTxUrl, shortHex, usdc } from './format'

/** Rows shown before "show all" */
const ROWS = 10

/** The first rows of a list, and a button for the rest */
function useRows<T>(rows: T[]): [T[], React.ReactNode] {
  const [all, setAll] = useState(false)
  if (all || rows.length <= ROWS + 2) return [rows, null]
  return [
    rows.slice(0, ROWS),
    <button
      key="more"
      type="button"
      className="toggle mt-1 text-xs"
      onClick={() => setAll(true)}
    >
      show all {rows.length}
    </button>,
  ]
}

export function DepositTable({ deposits }: { deposits: Deposit[] }) {
  const [shown, more] = useRows(deposits)
  const total = deposits.reduce((a, d) => a + d.amount, 0)
  const showHops = deposits.some((d) => d.hops !== undefined)
  return (
    <table className="w-full text-left text-xs">
      <thead style={{ color: 'var(--muted)' }}>
        <tr>
          <th className="py-1 font-normal">Deposit from</th>
          <th className="py-1 text-right font-normal">USDC</th>
          {showHops && <th className="py-1 text-right font-normal">Hops</th>}
          <th className="py-1 font-normal">Chain</th>
          <th className="py-1 font-normal">Time</th>
          <th className="py-1 font-normal">L1 tx</th>
          <th className="py-1 font-normal">Payy tx</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((d) => (
          <tr key={d.mintHash} className="row hairline border-t">
            <td className="py-1">
              <Address address={d.depositor} chain={d.chain} full />
            </td>
            <td className="mono py-1 text-right">{usdc(d.amount)}</td>
            {showHops && (
              <td className="mono py-1 text-right">{d.hops ?? ''}</td>
            )}
            <td className="py-1">{CHAINS[d.chain].name}</td>
            <td className="mono py-1">{date(d.time)}</td>
            <td className="mono py-1">
              <a
                href={l1TxUrl(d.chain, d.l1Tx)}
                target="_blank"
                rel="noreferrer"
              >
                {shortHex(d.l1Tx, 6)}
              </a>
            </td>
            <td className="mono py-1">
              <a href={payyTxUrl(d.txHash)} target="_blank" rel="noreferrer">
                {shortHex(d.txHash, 6)}
              </a>
            </td>
          </tr>
        ))}
        {deposits.length > 1 && (
          <tr className="hairline border-t" style={{ color: 'var(--ink-2)' }}>
            <td className="py-1">{deposits.length} deposits</td>
            <td className="mono py-1 text-right">{usdc(total)}</td>
            <td colSpan={showHops ? 5 : 4} />
          </tr>
        )}
      </tbody>
      {more && <caption className="caption-bottom text-left">{more}</caption>}
    </table>
  )
}

export function WithdrawalTable({
  withdrawals,
  selected,
  onToggle,
}: {
  withdrawals: Withdrawal[]
  selected?: Set<string>
  onToggle?: (txHash: string) => void
}) {
  const [shown, more] = useRows(withdrawals)
  return (
    <table className="w-full text-left text-xs">
      <thead style={{ color: 'var(--muted)' }}>
        <tr>
          <th className="py-1 font-normal">Withdrawal to</th>
          <th className="py-1 text-right font-normal">USDC</th>
          <th className="py-1 font-normal">Chain</th>
          <th className="py-1 font-normal">Time</th>
          <th className="py-1 font-normal">L1 tx</th>
          <th className="py-1 font-normal">Payy tx</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((w) => (
          <tr
            key={w.burnHash}
            className={`row hairline border-t ${selected?.has(w.txHash) ? 'selected' : ''} ${onToggle ? 'cursor-pointer' : ''}`}
            onClick={() => onToggle?.(w.txHash)}
          >
            <td className="py-1">
              <Address address={w.recipient} chain={w.chain} full />
              {w.substituted && (
                <span className="chip ml-2" title="paid early by Payy">
                  fronted
                </span>
              )}
            </td>
            <td className="mono py-1 text-right">{usdc(w.amount)}</td>
            <td className="py-1">
              {w.chain ? CHAINS[w.chain].name : 'pending'}
            </td>
            <td className="mono py-1">{date(w.time)}</td>
            <td className="mono py-1">
              {w.chain && w.paidTx && (
                <a
                  href={l1TxUrl(w.chain, w.paidTx)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortHex(w.paidTx, 6)}
                </a>
              )}
            </td>
            <td className="mono py-1">
              <a href={payyTxUrl(w.txHash)} target="_blank" rel="noreferrer">
                {shortHex(w.txHash, 6)}
              </a>
            </td>
          </tr>
        ))}
      </tbody>
      {more && <caption className="caption-bottom text-left">{more}</caption>}
    </table>
  )
}
