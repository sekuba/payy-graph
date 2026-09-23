import { expect } from 'earl'
import { openDb } from '../db'
import { insertTxns } from '../payy/indexer'
import { getTxn } from './closure'
import { heightAt } from './live'
import { addr, txn } from './testing'
import { computeTrace, deriveTraces, traceOf } from './traces'

function history() {
  const db = openDb(':memory:')
  insertTxns(db, [
    txn('mintA', 1, 2, [], ['a'], 100),
    txn('mintB', 2, 2, [], ['b'], 50),
    // A's wallet: one payment, then a withdrawal of the rest
    txn('pay', 3, 1, ['a'], ['p', 'c']),
    txn('burnA', 4, 3, ['c'], [], 70, addr(0xaa)),
    // B merges the payment into its own note and withdraws
    txn('merge', 5, 1, ['b', 'p'], ['m']),
    txn('burnB', 6, 3, ['m'], [], 80, addr(0xbb)),
  ])
  const deposit = db.prepare(
    `insert into deposit (chain, mint_hash, block, tx, log_index, time, depositor, amount)
     values ('ethereum', 'mh', 1, '0x1', 0, 1, ?, 100)`,
  )
  deposit.run('0x00000000000000000000000000000000000000d1')
  return db
}

describe(computeTrace.name, () => {
  it('stores the sender behind the withdrawal', () => {
    const db = openDb(':memory:')
    insertTxns(db, [
      txn('mint', 1, 2, [], ['a'], 100_000_000),
      txn('burn', 2, 3, ['a'], ['c'], 70_000_000, addr(0xaa)),
    ])
    db.prepare(
      `insert into deposit (chain, mint_hash, block, tx, log_index, time, depositor, amount)
       values ('ethereum', 'mh', 1, '0x1', 0, 1, ?, 100000000)`,
    ).run('0x00000000000000000000000000000000000000d1')
    const burn = getTxn(db, 'burn')
    if (!burn) throw new Error('missing burn')
    expect(computeTrace(db, burn).sender).toEqual({
      address: '0x00000000000000000000000000000000000000d1',
      chain: undefined,
      deposits: 1,
      min: 70_000_000,
      max: 70_000_000,
    })
  })

  it('names the one deposit a withdrawal descends from', () => {
    const db = history()
    const burn = getTxn(db, 'burnA')
    if (!burn) throw new Error('missing burn')
    const t = computeTrace(db, burn)
    expect(t.origin).toEqual('deposit')
    expect(t.source?.depositor).toEqual(
      '0x00000000000000000000000000000000000000d1',
    )
    expect(t.source?.hops).toEqual(2)
    // 0.00007 USDC: under a cent, so no sender is named
    expect(t.sender).toEqual(undefined)
    expect(t.depositors).toEqual(1)
  })

  it('counts the depositors behind a merge', () => {
    const db = history()
    const burn = getTxn(db, 'burnB')
    if (!burn) throw new Error('missing burn')
    const t = computeTrace(db, burn)
    expect(t.origin).toEqual('merge')
    expect(t.source).toEqual(undefined)
    expect(t.nearest).toEqual(2)
  })
})

describe(deriveTraces.name, () => {
  it('backfills every withdrawal, newest first', () => {
    const db = history()
    deriveTraces(db, Number.POSITIVE_INFINITY)
    expect(traceOf(db, 'burnA')?.origin).toEqual('deposit')
    expect(traceOf(db, 'burnB')?.origin).toEqual('merge')
  })
})

describe(heightAt.name, () => {
  it('finds the first height at or after a time', () => {
    const db = history()
    expect(heightAt(db, 0)).toEqual(0)
    expect(heightAt(db, 3)).toEqual(3)
    expect(heightAt(db, 3.5)).toEqual(4)
    expect(heightAt(db, 99)).toEqual(6)
  })
})
