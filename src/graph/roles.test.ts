import { expect } from 'earl'
import { openDb } from '../db'
import { insertTxns } from '../payy/indexer'
import { CARD_SETTLEMENT } from '../protocol'
import { getTxn } from './closure'
import { walkPath } from './path'
import { graphAround } from './queries'
import { cardBatch, deriveCardBatches, Role, roleOf } from './roles'
import { addr, txn } from './testing'

const CARD = addr(CARD_SETTLEMENT[0] ?? '')

/**
 * Two wallets pay with the card: wallet A twice (p1, p2), wallet B once
 * (p3). The collector merges the three payments and withdraws 70.
 */
function cardHistory() {
  const db = openDb(':memory:')
  insertTxns(db, [
    txn('mintA', 1, 2, [], ['a'], 100),
    txn('a1', 2, 1, ['a'], ['p1', 'c1']),
    txn('a2', 3, 1, ['c1'], ['p2', 'c2']),
    txn('mintB', 4, 2, [], ['x'], 50),
    txn('b1', 5, 1, ['x'], ['p3', 'c3']),
    txn('k1', 6, 1, ['p1', 'p3'], ['k1n']),
    txn('k2', 7, 1, ['k1n', 'p2'], ['k2n']),
    txn('card', 8, 3, ['k2n'], [], 70, CARD),
  ])
  deriveCardBatches(db)
  return db
}

describe(deriveCardBatches.name, () => {
  it('assigns the merges to the batch and counts the payments', () => {
    const db = cardHistory()
    for (const h of ['k1', 'k2', 'card']) {
      expect({ ...roleOf(db, h) }).toEqual({
        tx: h,
        role: Role.Card,
        batch: 'card',
      })
    }
    expect(roleOf(db, 'a2')).toEqual(undefined)
    expect(cardBatch(db, 'card')?.notes).toEqual(3)
  })
})

describe(graphAround.name, () => {
  it('stops at a card batch instead of walking into other wallets', () => {
    const db = cardHistory()
    const g = graphAround(db, ['a2'], { backward: true, forward: true })
    expect(g.txns.map((t) => t.hash)).toEqual(['mintA', 'a1', 'a2'])
    expect(g.batches.map((b) => [b.burnTx, b.notes, b.amount])).toEqual([
      ['card', 3, 70],
    ])
    const p2 = g.notes.find((n) => n.commitment === 'p2')
    expect(p2?.batch).toEqual('card')
    // at most the batch total, since other payments share it
    expect(p2?.max).toEqual(70)
  })

  it('follows each direction only from what it reached', () => {
    const db = openDb(':memory:')
    insertTxns(db, [
      txn('mintA', 1, 2, [], ['a'], 10),
      txn('mintB', 2, 2, [], ['b'], 20),
      // merge of A and B, then a payment of the result
      txn('merge', 3, 1, ['a', 'b'], ['m']),
      txn('pay', 4, 1, ['m'], ['out', 'rest']),
      // a sibling spend of B's history that is neither ancestor nor descendant
      txn('mintC', 5, 2, [], ['c'], 5),
      txn('other', 6, 1, ['c', 'out'], ['o']),
    ])
    const g = graphAround(db, ['merge'], { backward: true, forward: true })
    expect(g.txns.map((t) => t.hash)).toEqual([
      'mintA',
      'mintB',
      'merge',
      'pay',
      'other',
    ])
  })
})

describe(walkPath.name, () => {
  it('pins a card payment that is alone in its batch', () => {
    const db = openDb(':memory:')
    insertTxns(db, [
      txn('mint', 1, 2, [], ['a'], 100),
      txn('pay', 2, 1, ['a'], ['p', 'c']),
      txn('card', 3, 3, ['p'], [], 30, CARD),
      txn('burn', 4, 3, ['c'], [], 70, addr(0xbb)),
    ])
    deriveCardBatches(db)
    const burn = getTxn(db, 'burn')
    if (!burn) throw new Error('missing burn')
    const pay = walkPath(db, burn).hops.find((h) => h.txHash === 'pay')
    expect(pay?.out?.destination.type).toEqual('card')
    expect(pay?.out?.value).toEqual(30)
  })
})
