import { expect } from 'earl'
import { openDb } from '../db'
import { insertTxns } from '../payy/indexer'
import { getTxn } from './closure'
import { amountMatch, MATCH_WINDOW } from './live'
import { addr, txn } from './testing'

describe(amountMatch.name, () => {
  const setup = (amount: number, depositedAt: number) => {
    const db = openDb(':memory:')
    const height = depositedAt + 10
    insertTxns(db, [txn('burn', height, 3, ['x'], [], amount, addr(0xaa))])
    db.prepare(
      `insert into deposit (chain, mint_hash, block, tx, log_index, time, depositor, amount)
       values ('ethereum', 'mh', 1, '0x1', 0, ?, '0xd1', ?)`,
    ).run(depositedAt, amount)
    const burn = getTxn(db, 'burn')
    if (!burn) throw new Error('missing burn')
    return { db, burn }
  }

  it('pairs a withdrawal with a deposit of the same odd amount', () => {
    const { db, burn } = setup(1_298_620_975, 100)
    expect(amountMatch(db, burn)).toEqual({
      count: 1,
      depositor: '0xd1',
      chain: 'ethereum',
      time: 100,
    })
  })

  it('ignores whole amounts, which are too common', () => {
    const { db, burn } = setup(100_000_000, 100)
    expect(amountMatch(db, burn)).toEqual(undefined)
  })

  it('ignores deposits outside the window', () => {
    const { db } = setup(1_298_620_975, 100)
    db.prepare('update txn set time = ?').run(100 + MATCH_WINDOW + 1)
    const later = getTxn(db, 'burn')
    if (!later) throw new Error('missing burn')
    expect(amountMatch(db, later)).toEqual(undefined)
  })
})
