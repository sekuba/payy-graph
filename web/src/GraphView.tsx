import { useEffect, useMemo, useRef, useState } from 'react'
import type { Graph, NoteEdge } from '../../src/graph/types'
import { useAddressText } from './Address'
import { originName } from './Bridge'
import { DUST, date, shortHex, usdc } from './format'
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

/** Parts of the graph that can put less than a cent into the focus are faint */
const faint = (reach: number | undefined) => reach !== undefined && reach < DUST

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
    ...graph.deposits.flatMap((d) =>
      d.bridge ? [d.bridge.funder?.address ?? d.bridge.depositor] : [],
    ),
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

  // iOS Safari ignores touch-action on SVG and scrolls or zooms the page
  // instead of passing the gesture on as pointer events, so its default
  // touch handling is turned off inside the graph (listeners that may
  // cancel must not be passive, which React's are).
  useEffect(() => {
    const el = container.current
    if (!el) return
    const stop = (e: Event) => e.preventDefault()
    const touch = { passive: false } as const
    el.addEventListener('touchmove', stop, touch)
    el.addEventListener('gesturestart', stop, touch)
    el.addEventListener('gesturechange', stop, touch)
    return () => {
      el.removeEventListener('touchmove', stop)
      el.removeEventListener('gesturestart', stop)
      el.removeEventListener('gesturechange', stop)
    }
  }, [])

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
  // One pointer pans; two (a pinch on a touch screen) zoom around their
  // midpoint. Pointers are tracked by id so that both work together.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number } | undefined>(undefined)
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }
    } else {
      drag.current = undefined
      pinch.current = { distance: spread(pointers.current) }
    }
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size === 2) {
      const distance = spread(pointers.current)
      const ratio = distance / (pinch.current.distance || distance)
      pinch.current.distance = distance
      const rect = e.currentTarget.getBoundingClientRect()
      const [a, b] = [...pointers.current.values()]
      if (!a || !b) return
      const px = (a.x + b.x) / 2 - rect.left
      const py = (a.y + b.y) / 2 - rect.top
      setView((v) => {
        const k = Math.min(4, Math.max(0.2, v.k * ratio))
        return {
          k,
          x: px - ((px - v.x) * k) / v.k,
          y: py - ((py - v.y) * k) / v.k,
        }
      })
      return
    }
    if (!drag.current || e.buttons === 0) return
    const d = drag.current
    setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }))
  }
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId)
    pinch.current = undefined
    const [rest] = [...pointers.current.values()]
    drag.current = rest && { x: rest.x - view.x, y: rest.y - view.y }
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
    <div
      ref={container}
      className="relative h-full w-full overflow-hidden"
      style={{ touchAction: 'none' }}
    >
      <svg
        className="h-full w-full cursor-grab select-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(undefined)}
        style={{ touchAction: 'none' }}
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
      <Legend
        truncated={graph.truncated}
        dust={graph.txns.some((t) => faint(t.reach))}
        onMore={onMore}
      />
      {hover && <Tooltip hover={hover} graph={graph} />}
    </div>
  )
}

/** Distance between the first two pointers */
function spread(points: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...points.values()]
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
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
  // payments that leave the view are not faint: they do not fund it by
  // definition, but they are part of the story
  const dim =
    edge.from !== undefined &&
    edge.to !== undefined &&
    !edge.to.virtual &&
    notes.every((n) => faint(n.reach))
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
      opacity={dim ? 0.3 : undefined}
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
  const dim = group
    ? group.txns.every((t) => faint(t.reach))
    : !focused && faint(txn?.reach)
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
      opacity={dim ? 0.35 : undefined}
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
  // a bridged deposit by who sent it on the other chain
  for (const d of graph.deposits) {
    const b = d.bridge
    labels.set(
      d.txHash,
      b
        ? `${addressText(b.funder?.address ?? b.depositor)} · ${originName(b.chain)}`
        : addressText(d.depositor),
    )
  }
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
  dust,
  onMore,
}: {
  truncated: boolean
  /** some notes can put less than a cent into the focus */
  dust: boolean
  onMore?: () => void
}) {
  return (
    <div
      className="absolute right-3 bottom-3 left-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:top-3 sm:bottom-auto sm:left-auto sm:justify-end"
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
      {dust && (
        <span
          className="help flex items-center gap-1.5"
          title="Funds are fungible within a transaction, but every note caps what passes through it: from the faint part of the graph, less than one cent can have ended up in the withdrawal. Payy withdrawals are whole cents."
        >
          <svg width="20" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="20"
              y2="3"
              stroke="var(--axis)"
              strokeWidth="2"
              opacity={0.3}
            />
          </svg>
          under 1 cent reaches the withdrawal
        </span>
      )}
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
  // kept on screen on narrow viewports
  const style = {
    left: Math.max(4, Math.min(hover.x + 12, window.innerWidth - 280)),
    top: hover.y + 12,
    maxWidth: 'calc(100vw - 8px)',
  }
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
        {txn.reach !== undefined && txn.kind !== 3 && (
          <div style={{ color: 'var(--ink-2)' }}>
            at most <span className="mono">{usdc(txn.reach)}</span> of it can be
            in the withdrawal
          </div>
        )}
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
      {n.reach !== undefined && n.to && !n.continues && (
        <div style={{ color: 'var(--ink-2)' }}>
          at most <span className="mono">{usdc(n.reach)}</span> of it can be in
          the withdrawal
        </div>
      )}
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
