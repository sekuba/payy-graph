import { useEffect, useMemo, useRef, useState } from 'react'
import type { Graph, NoteEdge } from '../../src/graph/types'
import { useAddressText } from './Address'
import { date, shortHex, usdc } from './format'
import {
  CARD_ID,
  type Group,
  layoutGraph,
  MIGRATION_ID,
  NODE_H,
  NODE_W,
  type PlacedEdge,
  type PlacedNode,
} from './layout'

/** Graphs up to this many transactions are drawn without collapsing runs */
const SMALL = 12

const KIND = {
  1: { name: 'Send', color: 'var(--send)' },
  2: { name: 'Deposit', color: 'var(--deposit)' },
  3: { name: 'Withdrawal', color: 'var(--withdrawal)' },
} as const

const VIRTUAL = {
  migration: { name: 'Migration', color: 'var(--muted)' },
  card: { name: 'Payy card', color: 'var(--card)' },
} as const

interface Props {
  graph: Graph
  /** transactions the view was opened for */
  focus: Set<string>
  onSelect: (hash: string) => void
  /** load a larger graph; offered when the graph was truncated */
  onMore?: () => void
}

type Hover =
  | { kind: 'node'; node: PlacedNode; x: number; y: number }
  | { kind: 'edge'; edge: PlacedEdge; x: number; y: number }

interface View {
  x: number
  y: number
  k: number
}

export function GraphView({ graph, focus, onSelect, onMore }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const layout = useMemo(
    () => layoutGraph(graph, expanded, { collapse: graph.txns.length > SMALL }),
    [graph, expanded],
  )
  const addressText = useAddressText([
    ...graph.deposits.map((d) => d.depositor),
    ...graph.withdrawals.map((w) => w.recipient),
  ])
  const labels = nodeLabels(graph, addressText)
  const [hover, setHover] = useState<Hover | undefined>()
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number } | undefined>(undefined)

  // Fit the whole graph when it stays readable, otherwise start at a
  // readable scale centred on the focused transactions and let the reader pan.
  useEffect(() => {
    const el = container.current
    if (!el) return
    const { clientWidth: cw, clientHeight: ch } = el
    const fit = Math.min(1, cw / layout.width, ch / layout.height)
    const k = Math.max(0.6, fit)
    const focused = layout.nodes.filter((n) => n.txn && focus.has(n.txn.hash))
    const target = k === fit || focused.length === 0 ? layout.nodes : focused
    const cx = average(target.map((n) => n.x + NODE_W / 2)) ?? layout.width / 2
    const cy = average(target.map((n) => n.y + NODE_H / 2)) ?? layout.height / 2
    setView({ x: cw / 2 - cx * k, y: ch / 2 - cy * k, k })
  }, [layout, focus])

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setView((v) => {
      const k = Math.min(4, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.1 : 0.9)))
      // keep the point under the cursor fixed
      return {
        k,
        x: px - ((px - v.x) * k) / v.k,
        y: py - ((py - v.y) * k) / v.k,
      }
    })
  }
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || e.buttons === 0) return
    const d = drag.current
    setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }))
  }
  const onPointerUp = () => {
    drag.current = undefined
  }

  const activate = (node: PlacedNode) => {
    if (node.group) {
      const id = node.group.id
      setExpanded((s) => new Set([...s, id]))
    } else if (node.txn) {
      onSelect(node.txn.hash)
    }
  }

  return (
    <div ref={container} className="relative h-full w-full overflow-hidden">
      <svg
        className="h-full w-full cursor-grab select-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(undefined)}
        role="img"
        aria-label="Spend graph"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.edges.map((e) => (
            <Edge
              key={e.notes[0]?.commitment}
              edge={e}
              onHover={(x, y) => setHover({ kind: 'edge', edge: e, x, y })}
              onLeave={() => setHover(undefined)}
            />
          ))}
          {layout.nodes.map((n) => (
            <Node
              key={n.id}
              node={n}
              label={labels.get(n.id)}
              focused={n.txn !== undefined && focus.has(n.txn.hash)}
              onHover={(x, y) => setHover({ kind: 'node', node: n, x, y })}
              onLeave={() => setHover(undefined)}
              onClick={() => activate(n)}
            />
          ))}
        </g>
      </svg>
      <Legend truncated={graph.truncated} onMore={onMore} />
      {hover && <Tooltip hover={hover} graph={graph} />}
    </div>
  )
}

function average(xs: number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined
}

function Edge({
  edge,
  onHover,
  onLeave,
}: {
  edge: PlacedEdge
  onHover: (x: number, y: number) => void
  onLeave: () => void
}) {
  const { notes } = edge
  const determined = notes.every((n) => n.value !== undefined)
  const leaves = edge.from && !edge.to
  const card = edge.to?.virtual === 'card'
  const label =
    notes.length > 1
      ? `×${notes.length}`
      : determined && edge.from && edge.to
        ? usdc(notes[0]?.value ?? 0)
        : undefined
  return (
    <g
      onPointerMove={(e) => onHover(e.clientX, e.clientY)}
      onPointerLeave={onLeave}
    >
      {/* wide invisible hit target */}
      <path d={edge.path} fill="none" stroke="transparent" strokeWidth={14} />
      <path
        d={edge.path}
        fill="none"
        stroke={card ? 'var(--card)' : 'var(--axis)'}
        strokeOpacity={card ? 0.5 : 1}
        strokeWidth={Math.min(6, 1 + notes.length)}
        strokeLinecap="round"
        strokeDasharray={determined ? undefined : '4 4'}
      />
      {leaves && (
        <circle
          cx={edge.end.x}
          cy={edge.end.y}
          r={4}
          fill={notes[0]?.continues ? 'var(--muted)' : 'var(--surface)'}
          stroke="var(--muted)"
          strokeWidth={2}
        />
      )}
      {label && (
        <text
          x={edge.mid.x}
          y={edge.mid.y - 5}
          textAnchor="middle"
          fontSize={11}
          fill="var(--ink-2)"
          className="mono"
        >
          {label}
        </text>
      )}
    </g>
  )
}

function Node({
  node,
  label,
  focused,
  onHover,
  onLeave,
  onClick,
}: {
  node: PlacedNode
  label: string | undefined
  focused: boolean
  onHover: (x: number, y: number) => void
  onLeave: () => void
  onClick: () => void
}) {
  const { txn, group, virtual } = node
  const kind = virtual ? VIRTUAL[virtual] : KIND[txn?.kind ?? 1]
  const title = group ? `${group.txns.length} sends` : kind.name
  const detail = group
    ? groupDetail(group)
    : virtual
      ? label
      : (label ?? shortHex(txn?.hash ?? '', 6))
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
    <g
      transform={`translate(${node.x} ${node.y})`}
      className="cursor-pointer"
      onPointerMove={(e) => onHover(e.clientX, e.clientY)}
      onPointerLeave={onLeave}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={6}
        fill="var(--surface)"
        stroke={focused ? 'var(--ink)' : 'var(--border)'}
        strokeWidth={focused ? 2 : 1}
        strokeDasharray={group ? '3 3' : undefined}
      />
      {virtual && (
        <rect
          width={NODE_W}
          height={NODE_H}
          rx={6}
          fill={kind.color}
          opacity={0.08}
        />
      )}
      <rect x={0} y={0} width={4} height={NODE_H} rx={2} fill={kind.color} />
      <text x={12} y={15} fontSize={11} fill="var(--ink-2)">
        {title}
        {txn && txn.kind !== 1 && (
          <tspan className="mono" fill="var(--ink)" fontWeight={600}>
            {` ${usdc(txn.amount)}`}
          </tspan>
        )}
      </text>
      <text x={12} y={29} fontSize={11} fill="var(--muted)" className="mono">
        {detail}
      </text>
    </g>
  )
}

function groupDetail(group: Group): string {
  const parts: string[] = []
  if (group.card) parts.push(`${group.card} card`)
  if (group.leaving) parts.push(`${group.leaving} out`)
  if (group.unspent) parts.push(`${group.unspent} unspent`)
  return parts.join(', ') || 'click to expand'
}

/**
 * Deposits show their depositor, withdrawals their recipient, the
 * boundaries what they stand for
 */
function nodeLabels(
  graph: Graph,
  addressText: (a: string) => string,
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const d of graph.deposits) labels.set(d.txHash, addressText(d.depositor))
  for (const w of graph.withdrawals) {
    labels.set(w.txHash, addressText(w.recipient))
  }
  labels.set(MIGRATION_ID, 'previous Payy chain')
  const payments = graph.notes.filter((n) => n.batch).length
  labels.set(CARD_ID, `${payments} payment${payments === 1 ? '' : 's'}`)
  return labels
}

function Legend({
  truncated,
  onMore,
}: {
  truncated: boolean
  onMore?: () => void
}) {
  return (
    <div
      className="absolute top-3 right-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs"
      style={{ color: 'var(--ink-2)' }}
    >
      {[...Object.values(KIND), VIRTUAL.card].map((k) => (
        <span key={k.name} className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-1 rounded-sm"
            style={{ background: k.color }}
          />
          {k.name}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg width="20" height="6" aria-hidden="true">
          <line
            x1="0"
            y1="3"
            x2="20"
            y2="3"
            stroke="var(--axis)"
            strokeWidth="2"
            strokeDasharray="4 4"
          />
        </svg>
        amount not determined
      </span>
      {truncated &&
        (onMore ? (
          <button type="button" className="toggle" onClick={onMore}>
            truncated · show more
          </button>
        ) : (
          <span className="chip">truncated</span>
        ))}
    </div>
  )
}

function Tooltip({ hover, graph }: { hover: Hover; graph: Graph }) {
  const style = { left: hover.x + 12, top: hover.y + 12 }
  if (hover.kind === 'node' && hover.node.virtual === 'migration') {
    const m = graph.migration
    return (
      <div className="tooltip" style={style}>
        <div>
          <strong>Migration distribution</strong>
        </div>
        {m && (
          <div style={{ color: 'var(--ink-2)' }}>
            {m.released.toLocaleString('en-US')} notes paid out, {date(m.start)}{' '}
            to {date(m.end)}
            <br />
            funded by {usdc(m.deposited)} USDC of treasury deposits
          </div>
        )}
        <div style={{ color: 'var(--muted)' }}>
          balances of the previous Payy chain; not linked to old wallets
        </div>
      </div>
    )
  }
  if (hover.kind === 'node' && hover.node.virtual === 'card') {
    const payments = graph.notes.filter((n) => n.batch).length
    const total = graph.batches.reduce((a, b) => a + b.amount, 0)
    const merged = graph.batches.reduce((a, b) => a + b.notes, 0)
    return (
      <div className="tooltip" style={style}>
        <div>
          <strong>Payy card</strong>
        </div>
        <div style={{ color: 'var(--ink-2)' }}>
          {payments} payments from this view in {graph.batches.length} batches
          <br />
          the batches merged {merged.toLocaleString('en-US')} payments and
          withdrew {usdc(total)} USDC
        </div>
        <div style={{ color: 'var(--muted)' }}>
          only batch totals are public; each payment is at most its batch
        </div>
      </div>
    )
  }
  if (hover.kind === 'node') {
    const { txn, group } = hover.node
    if (group) {
      const first = group.txns[0]
      const last = group.txns[group.txns.length - 1]
      return (
        <div className="tooltip" style={style}>
          <div>
            <strong>{group.txns.length} sends</strong> in a row
          </div>
          {first && last && (
            <div style={{ color: 'var(--ink-2)' }}>
              {date(first.time)} to {date(last.time)}
            </div>
          )}
          <div style={{ color: 'var(--ink-2)' }}>
            {group.card > 0 && `${group.card} card payments, `}
            {group.leaving} other notes leave this view, {group.unspent} unspent
          </div>
          <div style={{ color: 'var(--muted)' }}>click to expand</div>
        </div>
      )
    }
    if (!txn) return null
    return (
      <div className="tooltip" style={style}>
        <div>
          <strong>{KIND[txn.kind].name}</strong>
          {txn.kind !== 1 && (
            <span className="mono"> {usdc(txn.amount)} USDC</span>
          )}
        </div>
        <div style={{ color: 'var(--ink-2)' }}>
          height {txn.height} · {date(txn.time)}
        </div>
        <div className="mono" style={{ color: 'var(--muted)' }}>
          {shortHex(txn.hash, 8)}
        </div>
      </div>
    )
  }
  const { notes } = hover.edge
  if (notes.length > 1) {
    const known = notes.filter((n) => n.value !== undefined)
    return (
      <div className="tooltip" style={style}>
        <div>
          <strong>{notes.length} notes</strong>
          {hover.edge.to?.virtual === 'card' && ' paid with the card'}
        </div>
        <div style={{ color: 'var(--ink-2)' }}>
          {known.length === notes.length
            ? `${usdc(known.reduce((a, n) => a + (n.value ?? 0), 0))} USDC in total`
            : `${known.length} amounts determined`}
        </div>
      </div>
    )
  }
  const n = notes[0]
  if (!n) return null
  return (
    <div className="tooltip" style={style}>
      <div>
        <strong className="mono">{amountText(n)}</strong>
        <span style={{ color: 'var(--ink-2)' }}> USDC</span>
      </div>
      <div style={{ color: 'var(--ink-2)' }}>
        {n.batch
          ? 'paid with the card'
          : n.source
            ? 'paid out in the migration'
            : n.to
              ? n.continues
                ? 'spent outside this view'
                : 'spent'
              : 'unspent'}
      </div>
      <div className="mono" style={{ color: 'var(--muted)' }}>
        note {shortHex(n.commitment, 8)}
      </div>
    </div>
  )
}

function amountText(n: NoteEdge): string {
  if (n.value !== undefined) return usdc(n.value)
  if (n.max !== undefined) {
    return n.min > 0 ? `${usdc(n.min)} to ${usdc(n.max)}` : `≤ ${usdc(n.max)}`
  }
  return n.min > 0 ? `at least ${usdc(n.min)}` : 'amount hidden'
}
