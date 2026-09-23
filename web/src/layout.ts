import type { Graph, NoteEdge, TxnNode } from '../../src/graph/types'

/**
 * Layered left-to-right layout of the spend graph. Transactions are nodes,
 * notes are edges. Deposits sit on the left, withdrawals on the right, time
 * flows rightwards. This is the Sugiyama recipe:
 *
 * 1. layers by longest path from the sources;
 * 2. an edge that spans several layers gets a waypoint in each layer it
 *    crosses, so that it is routed between the nodes instead of through them;
 * 3. each layer is ordered by the mean position of its neighbours, sweeping
 *    back and forth, to reduce crossings;
 * 4. vertical positions: each node and waypoint as close as possible to its
 *    neighbours, without overlapping, by least squares under the order
 *    (isotonic regression, pool adjacent violators).
 *
 * The migration distribution, where the notes of older wallets come from,
 * is drawn as one node on the left. Card payments end in a short stub at the
 * transaction that paid them, instead of one far-away node all of them would
 * run to. A wallet that keeps spending from its change note produces a long
 * chain of sends; in a large graph such runs are drawn as one group node
 * until the reader expands them. Notes between the same two nodes are drawn
 * as one edge.
 */

export const NODE_W = 150
export const NODE_H = 36
const COL_GAP = 90
const ROW_GAP = 22
/** Space next to a waypoint, which is an edge passing through a layer */
const WAY_GAP = 8
const MARGIN = 40

export const MIGRATION_ID = '@migration'

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
  /** tx hash, group id, or the migration id */
  id: string
  txn?: TxnNode
  group?: Group
  /** a boundary the graph does not expand */
  virtual?: 'migration'
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
  /** paid with the Payy card: a stub at the paying transaction */
  card?: boolean
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

/** A node or a waypoint in a layer */
interface Item {
  id: string
  /** half its height: waypoints have none */
  half: number
  real: boolean
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
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const t of graph.txns) {
    preds.set(t.hash, [])
    succs.set(t.hash, [])
  }
  for (const n of graph.notes) {
    if (!inView(n.from) || !inView(n.to)) continue
    preds.get(n.to)?.push(n.from)
    succs.get(n.from)?.push(n.to)
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
  const drawn = graph.notes.flatMap((n) => {
    const from = inView(n.from)
      ? nodeId(n.from)
      : n.source === 'migration'
        ? MIGRATION_ID
        : undefined
    const to = inView(n.to) ? nodeId(n.to) : undefined
    if (from !== undefined && from === to) return []
    const fromGroup = inView(n.from) && groupOf.has(n.from)
    if (fromGroup && to === undefined) return []
    if (from === undefined && to === undefined) return []
    return [{ note: n, from, to, card: to === undefined && !!n.batch }]
  })

  // Nodes: the migration first, then height order (groups sit where their
  // first tx was)
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  if (drawn.some((e) => e.from === MIGRATION_ID)) add(MIGRATION_ID)
  for (const t of graph.txns) add(nodeId(t.hash))

  // Edges between nodes, bundled per pair
  const bundles = new Map<
    string,
    { from: string; to: string; notes: NoteEdge[] }
  >()
  for (const e of drawn) {
    if (e.from === undefined || e.to === undefined) continue
    const key = `${e.from} ${e.to}`
    const b = bundles.get(key) ?? { from: e.from, to: e.to, notes: [] }
    b.notes.push(e.note)
    bundles.set(key, b)
  }

  // 1. Layers: ids arrive in height order and a note is always created
  // before it is spent, so one pass places each node one past its latest
  // predecessor.
  const rPreds = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const b of bundles.values()) rPreds.get(b.to)?.push(b.from)
  const layer = new Map<string, number>()
  for (const id of ids) {
    const p = rPreds.get(id) ?? []
    layer.set(id, Math.max(-1, ...p.map((h) => layer.get(h) ?? 0)) + 1)
  }
  const layers: Item[][] = []
  const put = (l: number, item: Item) => {
    layers[l] ??= []
    layers[l].push(item)
  }
  for (const id of ids)
    put(layer.get(id) ?? 0, { id, half: NODE_H / 2, real: true })

  // 2. Waypoints for edges that span layers; `chains` lists each bundle's
  // items from its source to its target
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    down.set(a, [...(down.get(a) ?? []), b])
    up.set(b, [...(up.get(b) ?? []), a])
  }
  const chains = new Map<string, string[]>()
  for (const [key, b] of bundles) {
    const la = layer.get(b.from) ?? 0
    const lb = layer.get(b.to) ?? 0
    const chain = [b.from]
    for (let l = la + 1; l < lb; l++) {
      const id = `~${key}#${l}`
      put(l, { id, half: 0, real: false })
      chain.push(id)
    }
    chain.push(b.to)
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1]
      const c = chain[i]
      if (a && c) link(a, c)
    }
    chains.set(key, chain)
  }

  // 3. Ordering: sweep right then left a few times, sorting each layer by
  // the mean position of its neighbours in the adjacent layer.
  const position = new Map<string, number>()
  for (const l of layers) l?.forEach((it, i) => void position.set(it.id, i))
  const mean = (id: string, neighbours: string[] | undefined) => {
    const ps = (neighbours ?? []).map((n) => position.get(n) ?? 0)
    return ps.length
      ? ps.reduce((a, b) => a + b, 0) / ps.length
      : (position.get(id) ?? 0)
  }
  for (let sweep = 0; sweep < 6; sweep++) {
    const forward = sweep % 2 === 0
    const order = forward ? layers : [...layers].reverse()
    for (const l of order) {
      if (!l) continue
      const key = new Map(
        l.map((it) => [it.id, mean(it.id, (forward ? up : down).get(it.id))]),
      )
      l.sort((a, b) => (key.get(a.id) ?? 0) - (key.get(b.id) ?? 0))
      l.forEach((it, i) => void position.set(it.id, i))
    }
  }

  // 4. Vertical positions of the centres
  const gap = (a: Item, b: Item) => (a.real && b.real ? ROW_GAP : WAY_GAP)
  const center = new Map<string, number>()
  for (const l of layers) {
    let y = 0
    l?.forEach((it, i) => {
      const prev = l[i - 1]
      y = prev ? y + prev.half + gap(prev, it) + it.half : it.half
      center.set(it.id, y)
    })
  }
  for (let pass = 0; pass < 8; pass++) {
    const forward = pass % 2 === 0
    const both = pass >= 6
    const order = forward ? layers : [...layers].reverse()
    for (const l of order) {
      if (!l || l.length === 0) continue
      const desired = l.map((it) => {
        const ns = both
          ? [...(up.get(it.id) ?? []), ...(down.get(it.id) ?? [])]
          : ((forward ? up : down).get(it.id) ?? [])
        const cs = ns.map((n) => center.get(n) ?? 0)
        return cs.length
          ? cs.reduce((a, b) => a + b, 0) / cs.length
          : (center.get(it.id) ?? 0)
      })
      const placed = placeInOrder(
        l,
        desired,
        (i) => {
          const a = l[i]
          const b = l[i + 1]
          return a && b ? a.half + gap(a, b) + b.half : 0
        },
        (it) => (it.real ? 1 : 0.4),
      )
      l.forEach((it, i) => void center.set(it.id, placed[i] ?? 0))
    }
  }
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const l of layers) {
    for (const it of l ?? []) {
      const c = center.get(it.id) ?? 0
      top = Math.min(top, c - it.half)
      bottom = Math.max(bottom, c + it.half)
    }
  }
  if (!Number.isFinite(top)) {
    top = 0
    bottom = 0
  }
  const shift = ROW_GAP - top
  const yOf = (id: string) => (center.get(id) ?? 0) + shift
  const xOf = (l: number) => MARGIN + l * (NODE_W + COL_GAP)

  const nodes: PlacedNode[] = []
  const placed = new Map<string, PlacedNode>()
  layers.forEach((l, li) => {
    for (const it of l ?? []) {
      if (!it.real) continue
      const group = groupOf.get(it.id)
      const node: PlacedNode = {
        id: it.id,
        txn: group ? undefined : byHash.get(it.id),
        group,
        virtual: it.id === MIGRATION_ID ? 'migration' : undefined,
        layer: li,
        x: xOf(li),
        y: yOf(it.id) - NODE_H / 2,
      }
      nodes.push(node)
      placed.set(it.id, node)
    }
  })
  nodes.sort((a, b) => a.layer - b.layer || a.y - b.y)

  // Edges: along their waypoints, plus stubs for notes that enter or leave
  // the view and for card payments
  const edges: PlacedEdge[] = []
  for (const [key, b] of bundles) {
    const from = placed.get(b.from)
    const to = placed.get(b.to)
    if (!from || !to) continue
    const points = [{ x: from.x + NODE_W, y: from.y + NODE_H / 2 }]
    for (const id of chains.get(key)?.slice(1, -1) ?? []) {
      const l = Number(id.slice(id.lastIndexOf('#') + 1))
      points.push({ x: xOf(l), y: yOf(id) }, { x: xOf(l) + NODE_W, y: yOf(id) })
    }
    points.push({ x: to.x, y: to.y + NODE_H / 2 })
    edges.push({ notes: b.notes, from, to, ...route(points) })
  }
  const stubs = new Map<string, PlacedEdge>()
  for (const e of drawn) {
    if (e.from !== undefined && e.to !== undefined) continue
    const node = placed.get(e.from ?? e.to ?? '')
    if (!node) continue
    const kind = e.to === undefined ? (e.card ? 'card' : 'out') : 'in'
    const key = `${node.id} ${kind}`
    const stub = stubs.get(key)
    if (stub) {
      stub.notes.push(e.note)
      continue
    }
    const edge: PlacedEdge = {
      notes: [e.note],
      from: e.to === undefined ? node : undefined,
      to: e.to === undefined ? undefined : node,
      card: e.card,
      ...stub_(node, kind),
    }
    stubs.set(key, edge)
    edges.push(edge)
  }

  const width = MARGIN + layers.length * (NODE_W + COL_GAP) + MARGIN
  const height = bottom - top + 2 * ROW_GAP
  return { nodes, edges, width, height }
}

/**
 * Positions for items in a fixed order that are as close as possible to
 * where they want to be, in the least squares sense, while keeping at least
 * `space(i)` between item i and i + 1: with offsets o_i (the sum of the
 * spaces before i), y_i - o_i must not decrease, which is isotonic
 * regression of desired_i - o_i, solved by pooling adjacent violators.
 */
export function placeInOrder<T>(
  items: T[],
  desired: number[],
  space: (i: number) => number,
  weight: (item: T) => number,
): number[] {
  const offset: number[] = []
  let o = 0
  items.forEach((_, i) => {
    offset.push(o)
    o += space(i)
  })
  const blocks: { value: number; weight: number; count: number }[] = []
  items.forEach((it, i) => {
    let block = {
      value: (desired[i] ?? 0) - (offset[i] ?? 0),
      weight: weight(it),
      count: 1,
    }
    for (;;) {
      const last = blocks[blocks.length - 1]
      if (!last || last.value <= block.value) break
      blocks.pop()
      const w = last.weight + block.weight
      block = {
        value: (last.value * last.weight + block.value * block.weight) / w,
        weight: w,
        count: last.count + block.count,
      }
    }
    blocks.push(block)
  })
  const result: number[] = []
  for (const b of blocks) {
    for (let k = 0; k < b.count; k++) {
      result.push(b.value + (offset[result.length] ?? 0))
    }
  }
  return result
}

/** A smooth path through points left to right, straight within a layer */
function route(
  points: { x: number; y: number }[],
): Pick<PlacedEdge, 'path' | 'mid' | 'end'> {
  const [first] = points
  if (!first) return { path: '', mid: { x: 0, y: 0 }, end: { x: 0, y: 0 } }
  let path = `M${first.x},${first.y}`
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (!a || !b) continue
    if (b.x - a.x === NODE_W && a.y === b.y) {
      path += ` L${b.x},${b.y}`
    } else {
      const cx = (a.x + b.x) / 2
      path += ` C${cx},${a.y} ${cx},${b.y} ${b.x},${b.y}`
    }
  }
  const second = points[1] ?? first
  const last = points[points.length - 1] ?? first
  return {
    path,
    mid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    end: last,
  }
}

/**
 * Short stubs at a node: notes entering from outside the view on the left,
 * notes leaving it from the top right corner, card payments from the bottom
 * right corner, so that neither runs along the edges to the next layer.
 */
function stub_(
  node: PlacedNode,
  kind: 'in' | 'out' | 'card',
): Pick<PlacedEdge, 'path' | 'mid' | 'end'> {
  if (kind === 'in') {
    const y = node.y + NODE_H / 2
    const start = { x: node.x - COL_GAP * 0.5, y }
    return {
      path: `M${start.x},${y} L${node.x},${y}`,
      mid: { x: (start.x + node.x) / 2, y },
      end: { x: node.x, y },
    }
  }
  const x = node.x + NODE_W - 24
  const y = kind === 'out' ? node.y : node.y + NODE_H
  const end = { x: x + 26, y: kind === 'out' ? y - 12 : y + 12 }
  return {
    path: `M${x},${y} Q${x + 4},${end.y} ${end.x},${end.y}`,
    mid: { x: end.x + 10, y: end.y + 4 },
    end,
  }
}
