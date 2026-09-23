import type { Graph, NoteEdge, TxnNode } from '../../src/graph/types'

/**
 * Layered left-to-right layout of the spend graph. Transactions are nodes,
 * notes are edges. Deposits sit on the left, withdrawals on the right, time
 * flows rightwards. This is the classic Sugiyama recipe in its simplest form:
 * layer by longest path from the sources, then order each layer by the
 * average position of its neighbours to reduce crossings.
 *
 * Two kinds of node stand for what the graph does not expand: the
 * migration distribution, where the notes of older wallets come from, and
 * the Payy card, which all card payments go to. A wallet that keeps
 * spending from its change note produces a long chain of sends; in a large
 * graph such runs are drawn as one group node until the reader expands
 * them. Notes between the same two nodes are drawn as one edge.
 */

export const NODE_W = 150
export const NODE_H = 36
const COL_GAP = 90
const ROW_GAP = 22

export const MIGRATION_ID = '@migration'
export const CARD_ID = '@card'

export interface Group {
  /** id of the group: hash of its first transaction */
  id: string
  txns: TxnNode[]
  /** notes created inside the run and spent outside the view */
  leaving: number
  /** notes created inside the run and still unspent */
  unspent: number
  /** notes created inside the run and paid with the card */
  card: number
}

export interface PlacedNode {
  /** tx hash, group id, or one of the virtual ids */
  id: string
  txn?: TxnNode
  group?: Group
  /** a boundary the graph does not expand */
  virtual?: 'migration' | 'card'
  x: number
  y: number
  layer: number
}

export interface PlacedEdge {
  /** the notes this edge stands for (more than one when bundled) */
  notes: NoteEdge[]
  /** node the notes leave; undefined for notes created outside the view */
  from?: PlacedNode
  /** node the notes enter; undefined when unspent or spent outside the view */
  to?: PlacedNode
  path: string
  /** label anchor */
  mid: { x: number; y: number }
  end: { x: number; y: number }
}

export interface Layout {
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  width: number
  height: number
}

export function layoutGraph(
  graph: Graph,
  expanded: Set<string>,
  options: { collapse?: boolean } = {},
): Layout {
  const collapse = options.collapse ?? true
  const byHash = new Map(graph.txns.map((t) => [t.hash, t]))
  const inView = (h: string | undefined): h is string =>
    h !== undefined && byHash.has(h)
  // notes with both ends in view, as (creator, spender) pairs
  const links: [string, string][] = []
  for (const n of graph.notes) {
    if (inView(n.from) && inView(n.to)) links.push([n.from, n.to])
  }
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const t of graph.txns) {
    preds.set(t.hash, [])
    succs.set(t.hash, [])
  }
  for (const [from, to] of links) {
    preds.get(to)?.push(from)
    succs.get(from)?.push(to)
  }

  // Runs of sends with a single neighbour on each side collapse into groups
  const groupOf = new Map<string, Group>()
  const chainable = (h: string) =>
    byHash.get(h)?.kind === 1 &&
    preds.get(h)?.length === 1 &&
    succs.get(h)?.length === 1
  for (const t of collapse ? graph.txns : []) {
    const pred = preds.get(t.hash)?.[0]
    if (!chainable(t.hash) || (pred && chainable(pred))) continue
    const run: TxnNode[] = []
    let cur: string | undefined = t.hash
    while (cur && chainable(cur) && !groupOf.has(cur)) {
      const txn = byHash.get(cur)
      if (txn) run.push(txn)
      cur = succs.get(cur)?.[0]
    }
    const first = run[0]
    if (run.length < 2 || !first || expanded.has(first.hash)) continue
    const members = new Set(run.map((r) => r.hash))
    const side = graph.notes.filter(
      (n) => n.from && members.has(n.from) && !(n.to && members.has(n.to)),
    )
    const group: Group = {
      id: first.hash,
      txns: run,
      leaving: side.filter((n) => n.to && !byHash.has(n.to) && !n.batch).length,
      unspent: side.filter((n) => !n.to).length,
      card: side.filter((n) => n.batch).length,
    }
    for (const h of members) groupOf.set(h, group)
  }
  const nodeId = (h: string) => groupOf.get(h)?.id ?? h

  // Where each note is drawn from and to, in node ids. Notes inside a group
  // are not drawn; a group's notes that leave the view are summed up in it.
  const ends = (n: NoteEdge): { from?: string; to?: string } | undefined => {
    const from = inView(n.from)
      ? nodeId(n.from)
      : n.source === 'migration'
        ? MIGRATION_ID
        : undefined
    const to = inView(n.to) ? nodeId(n.to) : n.batch ? CARD_ID : undefined
    if (from !== undefined && from === to) return undefined
    const fromGroup = inView(n.from) && groupOf.has(n.from)
    if (fromGroup && to === undefined) return undefined
    if (from === undefined && to === undefined) return undefined
    return { from, to }
  }

  // Reduced node list: the migration first, then height order (groups sit
  // where their first tx was), then the card
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  const drawn = graph.notes.flatMap((n) => {
    const e = ends(n)
    return e ? [{ note: n, ...e }] : []
  })
  if (drawn.some((e) => e.from === MIGRATION_ID)) add(MIGRATION_ID)
  for (const t of graph.txns) add(nodeId(t.hash))
  if (drawn.some((e) => e.to === CARD_ID)) add(CARD_ID)

  const rPreds = new Map<string, string[]>()
  const rSuccs = new Map<string, string[]>()
  for (const id of ids) {
    rPreds.set(id, [])
    rSuccs.set(id, [])
  }
  for (const e of drawn) {
    if (e.from === undefined || e.to === undefined) continue
    rPreds.get(e.to)?.push(e.from)
    rSuccs.get(e.from)?.push(e.to)
  }

  // Layers: ids arrive in height order and a note is always created before
  // it is spent, so one pass places each node one past its latest predecessor.
  const layer = new Map<string, number>()
  for (const id of ids) {
    const p = rPreds.get(id) ?? []
    layer.set(id, Math.max(-1, ...p.map((h) => layer.get(h) ?? 0)) + 1)
  }
  const layers: string[][] = []
  for (const id of ids) {
    const l = layer.get(id) ?? 0
    layers[l] ??= []
    layers[l].push(id)
  }

  // Ordering: sweep right then left a few times, sorting each layer by the
  // mean position of its neighbours in the adjacent layer.
  const position = new Map<string, number>()
  for (const l of layers) l.forEach((h, i) => void position.set(h, i))
  const barycenter = (h: string, neighbours: string[]) => {
    const ps = neighbours.map((n) => position.get(n) ?? 0)
    return ps.length
      ? ps.reduce((a, b) => a + b, 0) / ps.length
      : (position.get(h) ?? 0)
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0
    const order = forward ? layers : [...layers].reverse()
    for (const l of order) {
      const key = (h: string) =>
        barycenter(h, (forward ? rPreds : rSuccs).get(h) ?? [])
      l.sort((a, b) => key(a) - key(b))
      l.forEach((h, i) => void position.set(h, i))
    }
  }

  const tallest = Math.max(1, ...layers.map((l) => l.length))
  const height = tallest * (NODE_H + ROW_GAP) + ROW_GAP
  const nodes: PlacedNode[] = []
  const placed = new Map<string, PlacedNode>()
  layers.forEach((l, li) => {
    const top = (height - l.length * (NODE_H + ROW_GAP) + ROW_GAP) / 2
    l.forEach((id, i) => {
      const group = groupOf.get(id)
      const node: PlacedNode = {
        id,
        txn: group ? undefined : byHash.get(id),
        group,
        virtual:
          id === MIGRATION_ID
            ? 'migration'
            : id === CARD_ID
              ? 'card'
              : undefined,
        layer: li,
        x: 40 + li * (NODE_W + COL_GAP),
        y: top + i * (NODE_H + ROW_GAP),
      }
      nodes.push(node)
      placed.set(id, node)
    })
  })

  // Edges: one per pair of nodes, plus stubs for notes that enter or leave
  // the view
  const edges: PlacedEdge[] = []
  const bundles = new Map<string, PlacedEdge>()
  for (const e of drawn) {
    const from = e.from === undefined ? undefined : placed.get(e.from)
    const to = e.to === undefined ? undefined : placed.get(e.to)
    const key = from && to ? `${from.id} ${to.id}` : undefined
    const bundle = key ? bundles.get(key) : undefined
    if (bundle) {
      bundle.notes.push(e.note)
      continue
    }
    const edge = { notes: [e.note], from, to, ...route(from, to) }
    edges.push(edge)
    if (key) bundles.set(key, edge)
  }

  const width = 40 + layers.length * (NODE_W + COL_GAP) + 40
  return { nodes, edges, width, height }
}

/** Cubic curve from the right edge of `from` to the left edge of `to`; a short
 * stub when one end is outside the view. */
function route(
  from: PlacedNode | undefined,
  to: PlacedNode | undefined,
): Pick<PlacedEdge, 'path' | 'mid' | 'end'> {
  const stub = COL_GAP * 0.6
  const start = from
    ? { x: from.x + NODE_W, y: from.y + NODE_H / 2 }
    : to
      ? { x: to.x - stub, y: to.y + NODE_H / 2 }
      : { x: 0, y: 0 }
  const end = to
    ? { x: to.x, y: to.y + NODE_H / 2 }
    : { x: start.x + stub, y: start.y }
  const cx = (start.x + end.x) / 2
  return {
    path: `M${start.x},${start.y} C${cx},${start.y} ${cx},${end.y} ${end.x},${end.y}`,
    mid: { x: cx, y: (start.y + end.y) / 2 },
    end,
  }
}
