import { expect } from 'earl'
import { TxKind } from '../protocol'
import { inferAmounts } from './amounts'
import type { NoteRow, Subgraph, TxnRow } from './closure'

/**
 * Small graphs built by hand. Notes are named by letters, transactions by
 * what they do. Amounts are in micro USDC like everywhere else.
 */
function graph(
  txns: { hash: string; kind: TxKind; amount?: number }[],
  notes: { id: string; from?: string; to?: string }[],
): Pick<Subgraph, 'txns' | 'notes'> {
  const txnMap = new Map<string, TxnRow>()
  for (const t of txns) {
    txnMap.set(t.hash, {
      hash: t.hash,
      height: 0,
      idx: 0,
      time: 0,
      kind: t.kind,
      amount: t.amount ?? 0,
      msg_hash: '',
      burn_addr: null,
    })
  }
  const noteMap = new Map<string, NoteRow>()
  notes.forEach((n, i) => {
    noteMap.set(n.id, {
      commitment: n.id,
      created_tx: n.from ?? null,
      created_idx: n.from ? i : null,
      spent_tx: n.to ?? null,
      spent_idx: n.to ? i : null,
    })
  })
  return { txns: txnMap, notes: noteMap }
}

describe(inferAmounts.name, () => {
  it('fixes every note along a path without splits or merges', () => {
    // deposit 9.067 -> burn 6 (change b) -> send (c) -> burn 3.06 (change e)
    const g = graph(
      [
        { hash: 'mint', kind: TxKind.Mint, amount: 9_067_000 },
        { hash: 'burn1', kind: TxKind.Burn, amount: 6_000_000 },
        { hash: 'send', kind: TxKind.Send },
        { hash: 'burn2', kind: TxKind.Burn, amount: 3_060_000 },
      ],
      [
        { id: 'a', from: 'mint', to: 'burn1' },
        { id: 'b', from: 'burn1', to: 'send' },
        { id: 'c', from: 'send', to: 'burn2' },
        { id: 'e', from: 'burn2' },
      ],
    )
    const amounts = inferAmounts(g)
    expect(amounts.get('a')?.value).toEqual(9_067_000)
    expect(amounts.get('b')?.value).toEqual(3_067_000)
    expect(amounts.get('c')?.value).toEqual(3_067_000)
    expect(amounts.get('e')?.value).toEqual(7_000)
  })

  it('only bounds the outputs of a split', () => {
    // deposit 100 -> send splits into x and y, x is burned for 30
    const g = graph(
      [
        { hash: 'mint', kind: TxKind.Mint, amount: 100 },
        { hash: 'split', kind: TxKind.Send },
        { hash: 'burn', kind: TxKind.Burn, amount: 30 },
      ],
      [
        { id: 'a', from: 'mint', to: 'split' },
        { id: 'x', from: 'split', to: 'burn' },
        { id: 'y', from: 'split' },
        { id: 'z', from: 'burn' },
      ],
    )
    const amounts = inferAmounts(g)
    expect(amounts.get('a')?.value).toEqual(100)
    expect(amounts.get('x')?.value).toEqual(undefined)
    // x paid a burn of 30, so it is at least 30, which caps y at 70
    expect(amounts.get('x')?.min).toEqual(30)
    expect(amounts.get('x')?.max).toEqual(100)
    expect(amounts.get('y')?.max).toEqual(70)
    // the burn's change is at most what could have come in, minus the burn
    expect(amounts.get('z')?.max).toEqual(70)
  })

  it('fixes the sum of a split that merges back, not the branches', () => {
    // deposit 100 -> split into x, y -> merge into m -> burn 30 (change c)
    const g = graph(
      [
        { hash: 'mint', kind: TxKind.Mint, amount: 100 },
        { hash: 'split', kind: TxKind.Send },
        { hash: 'merge', kind: TxKind.Send },
        { hash: 'burn', kind: TxKind.Burn, amount: 30 },
      ],
      [
        { id: 'a', from: 'mint', to: 'split' },
        { id: 'x', from: 'split', to: 'merge' },
        { id: 'y', from: 'split', to: 'merge' },
        { id: 'm', from: 'merge', to: 'burn' },
        { id: 'c', from: 'burn' },
      ],
    )
    const amounts = inferAmounts(g)
    expect(amounts.get('m')?.value).toEqual(100)
    expect(amounts.get('c')?.value).toEqual(70)
    expect(amounts.get('x')?.value).toEqual(undefined)
    expect(amounts.get('x')?.max).toEqual(100)
  })

  it('resolves a split once the other branch is known', () => {
    // as above, but y is burned entirely for 45, which fixes x = 55
    const g = graph(
      [
        { hash: 'mint', kind: TxKind.Mint, amount: 100 },
        { hash: 'split', kind: TxKind.Send },
        { hash: 'burnY', kind: TxKind.Burn, amount: 45 },
      ],
      [
        { id: 'a', from: 'mint', to: 'split' },
        { id: 'x', from: 'split' },
        { id: 'y', from: 'split', to: 'burnY' },
      ],
    )
    const amounts = inferAmounts(g)
    expect(amounts.get('y')?.value).toEqual(45)
    expect(amounts.get('x')?.value).toEqual(55)
  })
})
