import { useState } from 'react'
import type { Deposit, Withdrawal } from '../../src/graph/types'
import { CHAINS } from '../../src/protocol'
import { Address } from './Address'
import { BridgeText } from './Bridge'
import {
  between,
  DUST,
  date,
  FRONTED,
  l1TxUrl,
  payyTxUrl,
  shortHex,
  usdc,
} from './format'

/** What the share of a deposit means, for its column header */
const SHARE =
  'How much of the withdrawal can have come from this deposit. Funds are fungible within a transaction, so this is a range: every note caps what passes through it, and what the other deposits cannot cover must have come from this one.'

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
  // in a truncated graph only lower bounds are known, mostly zero
  const known = (d: Deposit) =>
    d.share !== undefined && (d.share.max !== undefined || d.share.min > 0)
  const showShare = deposits.some(known)
  return (
    <table className="stack w-full text-left text-xs">
      <thead style={{ color: 'var(--muted)' }}>
        <tr>
          <th className="py-1 font-normal">Deposit from</th>
          <th className="py-1 text-right font-normal">USDC</th>
          {showShare && (
            <th className="help py-1 text-right font-normal" title={SHARE}>
              In withdrawal
            </th>
          )}
          <th className="py-1 font-normal">Chain</th>
          <th className="py-1 font-normal">Time</th>
          <th className="py-1 font-normal">L1 tx</th>
          <th className="py-1 font-normal">Payy tx</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((d) => (
          <tr
            key={d.mintHash}
            className="row hairline border-t"
            style={
              d.share?.max !== undefined && d.share.max < DUST
                ? { color: 'var(--muted)' }
                : undefined
            }
          >
            <td className="py-1">
              <Address address={d.depositor} chain={d.chain} full />
              {d.bridge && (
                <div style={{ color: 'var(--muted)' }}>
                  <BridgeText deposit={d} />
                </div>
              )}
            </td>
            <td className="mono py-1 text-right">
              {usdc(d.amount)} <span className="sm:hidden">USDC</span>
            </td>
            {showShare && (
              <td className="mono py-1 text-right" data-label="in withdrawal">
                {d.share && known(d) && between(d.share.min, d.share.max)}
              </td>
            )}
            <td className="py-1">{CHAINS[d.chain].name}</td>
            <td className="mono py-1">{date(d.time)}</td>
            <td className="mono py-1" data-label="L1">
              <a
                href={l1TxUrl(d.chain, d.l1Tx)}
                target="_blank"
                rel="noreferrer"
              >
                {shortHex(d.l1Tx, 6)}
              </a>
            </td>
            <td className="mono py-1" data-label="Payy">
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
            <td colSpan={4 + (showShare ? 1 : 0)} />
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
    <table className="stack w-full text-left text-xs">
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
            style={
              w.reach !== undefined && w.reach < DUST
                ? { color: 'var(--muted)' }
                : undefined
            }
          >
            <td className="py-1">
              <Address address={w.recipient} chain={w.chain} full />
            </td>
            <td className="mono py-1 text-right">
              {usdc(w.amount)} <span className="sm:hidden">USDC</span>
            </td>
            <td
              className={`py-1 ${w.substituted ? 'help' : ''}`}
              title={w.substituted ? FRONTED : undefined}
            >
              {w.chain ? CHAINS[w.chain].name : 'pending'}
              {w.substituted && (
                <span style={{ color: 'var(--muted)' }}> · early</span>
              )}
            </td>
            <td className="mono py-1">{date(w.time)}</td>
            <td className="mono py-1" data-label="L1">
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
            <td className="mono py-1" data-label="Payy">
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
