import type { Db } from './db'
import { addressSummary, graphAround, resolve } from './graph/queries'
import type { Deposit, Graph, Withdrawal } from './graph/types'
import { CHAINS, USDC_DECIMALS } from './protocol'

/** Command line view of the graph: which deposits paid for a withdrawal */
export function trace(db: Db, input: string): void {
  const out = (s: string) => process.stdout.write(`${s}\n`)
  const resolved = resolve(db, input)
  switch (resolved.type) {
    case 'address': {
      const summary = addressSummary(db, resolved.address)
      out(`${resolved.address}${summary.label ? ` (${summary.label})` : ''}`)
      out(
        `  ${summary.withdrawals.length} withdrawals, ${summary.deposits.length} deposits`,
      )
      for (const w of summary.withdrawals) {
        out('')
        out(`withdrawal ${describeWithdrawal(w)}`)
        printGraph(
          out,
          graphAround(db, [w.txHash], { backward: true, forward: false }),
        )
      }
      break
    }
    case 'txn':
      printGraph(
        out,
        graphAround(db, [resolved.hash], { backward: true, forward: true }),
      )
      break
    case 'note': {
      const start = resolved.spentTx ?? resolved.createdTx
      printGraph(
        out,
        graphAround(db, start ? [start] : [], {
          backward: true,
          forward: false,
        }),
      )
      break
    }
    default:
      out('not an address, transaction hash or commitment known to the index')
  }
}

function printGraph(out: (s: string) => void, graph: Graph): void {
  out(
    `  ${graph.txns.length} transactions${graph.truncated ? ' (truncated)' : ''}`,
  )
  const determined = graph.notes.filter((n) => n.value !== undefined).length
  out(`  ${graph.notes.length} notes, ${determined} with inferred amounts`)
  for (const d of graph.deposits) out(`  deposit ${describeDeposit(d)}`)
  for (const w of graph.withdrawals)
    out(`  withdrawal ${describeWithdrawal(w)}`)
}

function describeDeposit(d: Deposit): string {
  const label = d.label ? ` (${d.label})` : ''
  return `${usdc(d.amount)} USDC from ${d.depositor}${label} on ${CHAINS[d.chain].name} ${date(d.time)} ${CHAINS[d.chain].explorer}/tx/${d.l1Tx}`
}

function describeWithdrawal(w: Withdrawal): string {
  const label = w.label ? ` (${w.label})` : ''
  const where = w.chain ? `on ${CHAINS[w.chain].name}` : 'not yet settled'
  const link =
    w.chain && w.paidTx ? ` ${CHAINS[w.chain].explorer}/tx/${w.paidTx}` : ''
  return `${usdc(w.amount)} USDC to ${w.recipient}${label} ${where} ${date(w.time)}${w.substituted ? ' (fronted)' : ''}${link}`
}

function usdc(amount: number): string {
  return (amount / 10 ** USDC_DECIMALS)
    .toFixed(USDC_DECIMALS)
    .replace(/\.?0+$/, '')
}

function date(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ')
}
