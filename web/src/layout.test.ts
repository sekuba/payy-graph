import { expect } from 'earl'
import type { Graph } from '../../src/graph/types'
import { CARD_ID, layoutGraph, MIGRATION_ID } from './layout'

/**
 * deposit -> send -> send -> send -> withdrawal, each send paying someone
 * (or paying with the card, with `card`)
 */
function chain(sends: number, card = false): Graph {
  const txns: Graph['txns'] = [
    { hash: 'mint', height: 0, time: 0, kind: 2, amount: 100 },
  ]
  const notes: Graph['notes'] = [{ commitment: 'n0', from: 'mint', min: 0 }]
  let note = 'n0'
  for (let i = 0; i < sends; i++) {
    const hash = `send${i}`
    txns.push({ hash, height: i + 1, time: i + 1, kind: 1, amount: 0 })
    const last = notes[notes.length - 1]
    if (last) last.to = hash
    notes.push({
      commitment: `paid${i}`,
      from: hash,
      to: `else${i}`,
      continues: true,
      ...(card && { batch: `batch${i}` }),
      min: 0,
    })
    notes.push({ commitment: `change${i}`, from: hash, min: 0 })
    note = `change${i}`
  }
  txns.push({
    hash: 'burn',
    height: sends + 1,
    time: sends + 1,
    kind: 3,
    amount: 10,
  })
  const last = notes.find((n) => n.commitment === note)
  if (last) last.to = 'burn'
  return {
    txns,
    notes,
    deposits: [],
    withdrawals: [],
    batches: [],
    truncated: false,
  }
}

describe(layoutGraph.name, () => {
  it('collapses a run of sends into one group and keeps the ends', () => {
    const layout = layoutGraph(chain(5), new Set())
    const ids = layout.nodes.map((n) => n.id)
    expect(ids).toEqual(['mint', 'send0', 'burn'])
    const group = layout.nodes.find((n) => n.group)?.group
    expect(group?.txns.length).toEqual(5)
    expect(group?.leaving).toEqual(5)
    // one column per node, left to right in time order
    expect(layout.nodes.map((n) => n.layer)).toEqual([0, 1, 2])
  })

  it('expands a group on request', () => {
    const layout = layoutGraph(chain(3), new Set(['send0']))
    expect(layout.nodes.length).toEqual(5)
    expect(layout.nodes.every((n) => !n.group)).toEqual(true)
  })

  it('sends card payments to one card node, bundled per source node', () => {
    const layout = layoutGraph(chain(4, true), new Set())
    expect(layout.nodes.map((n) => n.id)).toEqual([
      'mint',
      'send0',
      'burn',
      CARD_ID,
    ])
    expect(layout.nodes.find((n) => n.group)?.group?.card).toEqual(4)
    const toCard = layout.edges.filter((e) => e.to?.id === CARD_ID)
    expect(toCard.map((e) => e.notes.length)).toEqual([4])
  })

  it('draws migrated notes from the migration node', () => {
    const g = chain(1)
    g.txns = g.txns.filter((t) => t.hash !== 'mint')
    const first = g.notes.find((n) => n.commitment === 'n0')
    if (first) first.source = 'migration'
    const layout = layoutGraph(g, new Set())
    expect(layout.nodes[0]?.id).toEqual(MIGRATION_ID)
    expect(layout.edges.some((e) => e.from?.id === MIGRATION_ID)).toEqual(true)
  })

  it('keeps every transaction when collapsing is off', () => {
    const layout = layoutGraph(chain(5), new Set(), { collapse: false })
    expect(layout.nodes.length).toEqual(7)
  })
})
