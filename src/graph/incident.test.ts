import { expect } from 'earl'
import { openDb } from '../db'
import { insertTxns } from '../payy/indexer'
import { ZERO_COMMITMENT } from '../protocol'
import { getTxn } from './closure'
import { incident } from './live'
import { walkPath } from './path'
import { withdrawalOf } from './queries'
import { addr, txn } from './testing'

const R = addr(0xee)
const ZERO = ZERO_COMMITMENT
const SUBSTITUTOR = '0x7c7e3fd85854be2d95516eda97a808424e717978'

/**
 * Two withdrawals that consume no note (their burn hash is zero) to the
 * same recipient, and one ordinary withdrawal. The first is settled by
 * the state update at block 10, the second fronted at block 11 and
 * settled at block 20, which refunds the substitutor.
 */
function history() {
  const db = openDb(':memory:')
  insertTxns(db, [
    txn('mint', 1, 2, [], ['a'], 100),
    txn('ok', 2, 3, ['a'], [], 100, addr(0xaa)),
    txn('big', 3, 3, [], [], 1_000_000, R),
    txn('small', 5, 3, [], [], 1, R),
  ])
  db.exec(
    `insert into settlement (chain, height, block, tx, time, root) values
       ('ethereum', 4, 10, '0xs1', 10, 'r1'), ('ethereum', 6, 20, '0xs2', 20, 'r2')`,
  )
  const burned = db.prepare(
    `insert into burned (chain, tx, log_index, block, time, burn_hash, recipient, substitute, success)
     values ('ethereum', ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  burned.run('0xs1', 1, 10, 10, ZERO, `0x${R.slice(24)}`, 0)
  burned.run('0xf', 1, 11, 11, ZERO, `0x${R.slice(24)}`, 1)
  // the settlement of the fronted burn refunds the substitutor
  burned.run('0xs2', 1, 20, 20, ZERO, SUBSTITUTOR, 0)
  return db
}

describe('withdrawals without a note', () => {
  const db = history()

  it('have their own path origin', () => {
    const big = getTxn(db, 'big')
    if (!big) throw new Error('missing burn')
    expect(walkPath(db, big).origin).toEqual({ type: 'none' })
    const ok = getTxn(db, 'ok')
    if (!ok) throw new Error('missing burn')
    expect(walkPath(db, ok).origin.type).toEqual('deposit')
  })

  it('are paired with their payouts in settlement order', () => {
    const big = getTxn(db, 'big')
    const small = getTxn(db, 'small')
    if (!big || !small) throw new Error('missing burn')
    const w1 = withdrawalOf(db, big)
    expect(w1.settledTx).toEqual('0xs1')
    expect(w1.substituted).toEqual(false)
    const w2 = withdrawalOf(db, small)
    expect(w2.settledTx).toEqual('0xs2')
    expect(w2.paidTx).toEqual('0xf')
    expect(w2.substituted).toEqual(true)
  })

  it('are counted for the live view', () => {
    const i = incident(db)
    expect(i.noNote.count).toEqual(2)
    expect(i.noNote.amount).toEqual(1_000_001)
    expect(i.malformed.count).toEqual(0)
  })
})
