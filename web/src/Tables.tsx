import type { Deposit, Withdrawal } from '../../src/graph/types'
import { CHAINS } from '../../src/protocol'
import {
  date,
  l1AddressUrl,
  l1TxUrl,
  payyTxUrl,
  shortHex,
  usdc,
} from './format'

export function DepositTable({ deposits }: { deposits: Deposit[] }) {
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
        {deposits.map((d) => (
          <tr key={d.mintHash} className="row hairline border-t">
            <td className="mono py-1">
              <a
                href={l1AddressUrl(d.chain, d.depositor)}
                target="_blank"
                rel="noreferrer"
              >
                {d.depositor}
              </a>
              {d.label && <span className="chip ml-2">{d.label}</span>}
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
        {withdrawals.map((w) => (
          <tr
            key={w.burnHash}
            className={`row hairline border-t ${selected?.has(w.txHash) ? 'selected' : ''} ${onToggle ? 'cursor-pointer' : ''}`}
            onClick={() => onToggle?.(w.txHash)}
          >
            <td className="mono py-1">
              {w.chain ? (
                <a
                  href={l1AddressUrl(w.chain, w.recipient)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {w.recipient}
                </a>
              ) : (
                w.recipient
              )}
              {w.label && <span className="chip ml-2">{w.label}</span>}
              {w.substituted && <span className="chip ml-2">fronted</span>}
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
    </table>
  )
}
