import { expect } from 'earl'
import { openDb } from '../db'
import { insertTxns } from '../payy/indexer'
import { getTxn } from './closure'
import { walkPath } from './path'
import { graphAround } from './queries'
import { flowInto } from './sources'
import { addr, txn } from './testing'

/**
 * The shape of a real history: a wallet deposits 9.067, withdraws 6, pays
 * 3.06 of the remaining 3.067 to someone who withdraws it, and keeps 0.007.
 * Days later it deposits 2.892723 and merges the 0.007 into the notes it
 * withdraws 2.88 from.
 */
function history() {
  const db = openDb(':memory:')
  insertTxns(db, [
    txn('mint1', 1, 2, [], ['a'], 9_067_000),
    txn('burn6', 2, 3, ['a'], ['b'], 6_000_000, addr(0xe4)),
    // split and merge back
    txn('split', 3, 1, ['b'], ['c', 'd']),
    txn('rejoin', 4, 1, ['c', 'd'], ['e']),
    txn('pay', 5, 1, ['e'], ['p', 'dust']),
    // the payee withdraws the payment in full
    txn('receive', 6, 1, ['p'], ['q']),
    txn('burnPayee', 7, 3, ['q'], [], 3_060_000, addr(0xc6)),
    txn('mint2', 8, 2, [], ['g'], 2_892_723),
    txn('split2', 9, 1, ['g'], ['h', 'i']),
    txn('merge', 10, 1, ['dust', 'h'], ['j']),
    txn('split3', 11, 1, ['j'], ['k', 'kept']),
    txn('merge2', 12, 1, ['i', 'k'], ['m']),
    txn('burn', 13, 3, ['m'], ['change'], 2_880_000, addr(0x33)),
  ])
  db.prepare(
    `insert into deposit (chain, mint_hash, block, tx, log_index, time, depositor, amount)
     values ('ethereum', 'mh', 1, '0x1', 0, 1, ?, 1)`,
  ).run('0x00000000000000000000000000000000000000d1')
  return db
}

describe(flowInto.name, () => {
  it('bounds a deposit that reaches the withdrawal only as dust', () => {
    const g = graphAround(history(), ['burn'], {
      backward: true,
      forward: false,
    })
    // known only by following the payment forward to its withdrawal
    expect(g.notes.find((n) => n.commitment === 'dust')?.value).toEqual(7_000)
    const share = (tx: string) => g.deposits.find((d) => d.txHash === tx)?.share
    expect(share('mint1')).toEqual({ min: 0, max: 7_000 })
    expect(share('mint2')).toEqual({ min: 2_873_000, max: 2_880_000 })
    // the larger share first
    expect(g.deposits.map((d) => d.txHash)).toEqual(['mint2', 'mint1'])
    // the split before the payment is counted once
    expect(g.txns.find((t) => t.hash === 'mint1')?.reach).toEqual(7_000)
    expect(g.txns.find((t) => t.hash === 'burn6')?.reach).toEqual(7_000)
    // the payment does not reach the withdrawal at all
    expect(g.notes.find((n) => n.commitment === 'p')?.reach).toEqual(0)
  })

  it('names the sources of a history that begins with a merge', () => {
    const db = history()
    const burn = getTxn(db, 'burn')
    if (!burn) throw new Error('missing burn')
    const path = walkPath(db, burn)
    expect(path.origin.type).toEqual('merge')
    expect(path.sources.map((d) => [d.txHash, d.share])).toEqual([
      ['mint2', { min: 2_873_000, max: 2_880_000 }],
      ['mint1', { min: 0, max: 7_000 }],
    ])
  })

  it('gives only lower bounds when the graph is truncated', () => {
    const g = graphAround(
      history(),
      ['burn'],
      {
        backward: true,
        forward: false,
      },
      4,
    )
    expect(g.truncated).toEqual(true)
    expect(g.txns.every((t) => t.reach === undefined)).toEqual(true)
    for (const d of g.deposits) expect(d.share?.max).toEqual(undefined)
  })

  it('leaves views that are not backward from withdrawals alone', () => {
    const g = graphAround(history(), ['burn'], {
      backward: true,
      forward: true,
    })
    expect(g.deposits.every((d) => d.share === undefined)).toEqual(true)
    expect(g.notes.every((n) => n.reach === undefined)).toEqual(true)
  })
})
