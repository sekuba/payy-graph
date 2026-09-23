import { expect } from 'earl'
import { openDb } from '../db'
import { insertTxns } from '../payy/indexer'
import { getTxn } from './closure'
import { walkPath } from './path'
import { addr, txn } from './testing'

describe(walkPath.name, () => {
  it('walks back to the deposit and lists what each send released', () => {
    const db = openDb(':memory:')
    insertTxns(db, [
      txn('mint', 1, 2, [], ['a'], 100),
      txn('pay1', 2, 1, ['a'], ['b', 'p1']),
      txn('pay2', 3, 1, ['b'], ['c', 'p2']),
      txn('burnP1', 4, 3, ['p1'], [], 30, addr(0xaa)),
      txn('burn', 5, 3, ['c'], ['change'], 50, addr(0xbb)),
    ])
    const burn = getTxn(db, 'burn')
    if (!burn) throw new Error('missing burn')
    const path = walkPath(db, burn)

    expect(path.origin.type).toEqual('deposit')
    expect(path.hops.map((h) => h.kind)).toEqual([
      'deposit',
      'send',
      'send',
      'withdrawal',
    ])
    const [, pay1, pay2] = path.hops
    expect(pay1?.out?.destination.type).toEqual('withdrawn')
    expect(pay1?.out?.value).toEqual(30)
    expect(pay2?.out?.destination.type).toEqual('unspent')
    // 100 in, 30 and 50 out, so the last payment plus change is 20
    expect(pay2?.out?.max).toEqual(20)
  })
})
