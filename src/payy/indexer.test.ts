import { expect } from 'earl'
import { openDb } from '../db'
import { collect } from '../graph/closure'
import { TxKind } from '../protocol'
import { insertTxns, parseTxn } from './indexer'

const ZERO = '0'.repeat(64)
const KIND = '000200000000000000893c499c542cef5e3811e1192ce70d8cc03d5c33590000'
const word = (n: number) => n.toString(16).padStart(64, '0')

/** A real Payy burn as the node returns it (height 33066342) */
const BURN = {
  hash: '1894641659cf73984a79cdd25895e4d6fa2b6f871bbbf7bdd81095a7cb4d7149',
  block_height: 33066342,
  index_in_block: 0,
  time: 1790091102,
  public_inputs: {
    input_commitments: [
      '03130bf00f840b99e7f24715622d40448022f705453f86d7fae3f113a08a2d00',
      ZERO,
    ] as [string, string],
    output_commitments: [
      '14c62994a9a60f2799b5d4cc475fe8cbf4cb786af2c0b53340f94264ccd32757',
      ZERO,
    ] as [string, string],
    messages: [
      word(3),
      KIND,
      word(2_000_000),
      '03130bf00f840b99e7f24715622d40448022f705453f86d7fae3f113a08a2d00',
      '0000000000000000000000002b787b8bd6f9ffd28c9501a4769f55227461ee94',
    ] as [string, string, string, string, string],
  },
}

describe(parseTxn.name, () => {
  it('reads kind, amount, recipient and drops padding notes', () => {
    const r = parseTxn(BURN)
    expect(r.kind).toEqual(TxKind.Burn)
    expect(r.amount).toEqual(2_000_000)
    expect(r.burnAddr).toEqual('0x2b787b8bd6f9ffd28c9501a4769f55227461ee94')
    expect(r.inputs).toEqual([BURN.public_inputs.input_commitments[0]])
    expect(r.outputs).toEqual([BURN.public_inputs.output_commitments[0]])
    // the burn hash is the first consumed commitment
    expect(r.msgHash).toEqual(r.inputs[0] ?? '')
  })
})

describe(insertTxns.name, () => {
  it('links notes across transactions whichever order they arrive in', () => {
    const db = openDb(':memory:')
    const send = parseTxn({
      hash: 'aa',
      block_height: 2,
      index_in_block: 0,
      time: 2,
      public_inputs: {
        input_commitments: ['n1', ZERO],
        output_commitments: ['n2', 'n3'],
        messages: [word(1), ZERO, ZERO, ZERO, ZERO],
      },
    })
    const mint = parseTxn({
      hash: 'bb',
      block_height: 1,
      index_in_block: 0,
      time: 1,
      public_inputs: {
        input_commitments: [ZERO, ZERO],
        output_commitments: ['n1', ZERO],
        messages: [word(2), KIND, word(500), 'mh', ZERO],
      },
    })
    insertTxns(db, [send])
    insertTxns(db, [mint])

    const sub = collect(db, ['aa'], { backward: true, forward: false }, 10)
    expect([...sub.txns.keys()].sort()).toEqual(['aa', 'bb'])
    // sqlite rows have a null prototype, so compare plain copies
    expect({ ...sub.notes.get('n1') }).toEqual({
      commitment: 'n1',
      created_tx: 'bb',
      created_idx: 0,
      spent_tx: 'aa',
      spent_idx: 0,
    })
    expect(sub.notes.get('n3')?.spent_tx).toEqual(null)
  })
})
