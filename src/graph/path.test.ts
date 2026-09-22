import { expect } from 'earl'
import { openDb } from '../db'
import { insertTxns, parseTxn } from '../payy/indexer'
import { getTxn } from './closure'
import { walkPath } from './path'

const ZERO = '0'.repeat(64)
const KIND = '000200000000000000893c499c542cef5e3811e1192ce70d8cc03d5c33590000'
const word = (n: number) => n.toString(16).padStart(64, '0')
const addr = (n: number) =>
  `${'0'.repeat(24)}${n.toString(16).padStart(40, '0')}`

function txn(
  hash: string,
  height: number,
  kind: number,
  inputs: string[],
  outputs: string[],
  amount = 0,
  extra = ZERO,
) {
  return parseTxn({
    hash,
    block_height: height,
    index_in_block: 0,
    time: height,
    public_inputs: {
      input_commitments: [inputs[0] ?? ZERO, inputs[1] ?? ZERO],
      output_commitments: [outputs[0] ?? ZERO, outputs[1] ?? ZERO],
      messages: [
        word(kind),
        kind === 1 ? ZERO : KIND,
        word(amount),
        kind === 2 ? 'mh' : (inputs[0] ?? ZERO),
        extra,
      ],
    },
  })
}

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
