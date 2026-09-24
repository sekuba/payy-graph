import { expect } from 'earl'
import { openDb, setSync } from '../db'
import { insertTxns } from '../payy/indexer'
import { CARD_SETTLEMENT } from '../protocol'
import { deriveKeys, keyStats } from './keys'
import { deriveCardBatches, Role } from './roles'
import { addr, txn } from './testing'

const CARD = addr(CARD_SETTLEMENT[0] ?? '')
/** far enough ahead that a note made at the start counts as old */
const LATER = 100_000

/**
 * A migration distribution of three payouts (w1, w2, w3; c3 is the change
 * left at the end of the chain), then:
 * - w1 is moved to a new key right away (1-in/1-out) and withdrawn in full;
 * - w2 pays the card weeks later and its change is withdrawn;
 * - w3 is never spent.
 * Much later a deposit x is merged with the old change ch of w2's payment
 * and the result withdrawn: a sweep.
 */
function history() {
  const db = openDb(':memory:')
  insertTxns(db, [
    txn('root', 1, 2, [], ['t0'], 1000),
    txn('p1', 2, 1, ['t0'], ['w1', 'c1']),
    txn('p2', 3, 1, ['c1'], ['w2', 'c2']),
    txn('p3', 4, 1, ['c2'], ['w3', 'c3']),
    txn('rk', 12, 1, ['w1'], ['w1b']),
    txn('b1', 20, 3, ['w1b'], [], 300, addr(0xaa)),
    txn('pay', 4000, 1, ['w2'], ['p', 'ch']),
    txn('card', 4100, 3, ['p'], [], 100, CARD),
    txn('mintX', LATER, 2, [], ['x'], 20),
    txn('sw', LATER + 10, 1, ['ch', 'x'], ['m']),
    txn('bsw', LATER + 20, 3, ['m'], [], 70, addr(0xbb)),
  ])
  const role = db.prepare(
    `insert into role (tx, role, batch) values (?, ${Role.Migration}, 'migration')`,
  )
  for (const h of ['root', 'p1', 'p2', 'p3']) role.run(h)
  setSync(
    db,
    'roles_migration',
    JSON.stringify({
      start: 1,
      end: 4,
      released: 4,
      deposits: 1,
      deposited: 1000,
    }),
  )
  deriveCardBatches(db)
  deriveKeys(db, Number.POSITIVE_INFINITY)
  return db
}

describe(deriveKeys.name, () => {
  const db = history()
  const stats = keyStats(db, LATER)
  if (!stats) throw new Error('no stats')
  const m = stats.migration

  it('lists the payouts apart from the change at the end of the chain', () => {
    expect(m.payouts).toEqual(3)
    expect(m.change).toEqual(1)
    expect(m.classified).toEqual(3)
    expect(m.deposited).toEqual(1000)
  })

  it('classifies the first spend of each payout and how long it waited', () => {
    expect(m.first.rekey.count).toEqual(1)
    expect(m.first.rekey.withinHour).toEqual(1)
    expect(m.first.rekey.exactSum).toEqual(300)
    expect(m.first.card.count).toEqual(1)
    expect(m.first.card.withinHour).toEqual(0)
    expect(m.first.card.withinDay).toEqual(1)
    // the card payment is alone in its batch, so w2 = 100 + ch = 150
    expect(m.first.card.exactSum).toEqual(150)
    expect(m.first.unspent.count).toEqual(1)
    expect(m.first.unspent.medianHeld).toEqual(LATER - 4)
    expect(m.spent.count).toEqual(2)
    expect(m.spent.medianHeld).toEqual(4000 - 3)
    expect(m.first.rekey.examples[0]?.spentTx).toEqual('rk')
  })

  it('finds the sweep and bounds the old note by the withdrawal', () => {
    const s = stats.sweeps
    expect(s.count).toEqual(1)
    expect(s.withDeposit).toEqual(1)
    expect(s.small).toEqual(1)
    expect(s.smallSum).toEqual(50)
    expect(s.intoBurn).toEqual(1)
    expect(s.examples[0]?.burn?.tx).toEqual('bsw')
    expect(s.examples[0]?.old.age).toEqual(LATER + 10 - 4000)
  })

  it('counts the withdrawals whose note a 1-in/1-out send made', () => {
    expect(stats.burns.noChange.count).toEqual(2)
    expect(stats.burns.noChange.afterRekey).toEqual(1)
    expect(stats.burns.noChange.medianGap).toEqual(8)
    expect(stats.burns.withChange.count).toEqual(0)
  })
})
