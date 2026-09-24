import { useEffect, useRef, useState } from 'react'
import { senderOf } from '../../src/graph/senders'
import type { Deposit, Graph, Sender, Withdrawal } from '../../src/graph/types'
import { useAddressText } from './Address'
import { originName } from './Bridge'
import { between, DUST, date, usdc } from './format'

/** Sources drawn one by one; the rest are summed up in one node */
const SHOWN = 8
/** Below this width the graph runs top to bottom */
const NARROW = 560

interface Source {
  key: string
  title: string
  detail: string
  /** what it can have put into the withdrawal */
  min: number
  max?: number
  faint?: boolean
  onClick?: () => void
}

/**
 * The simple view of one withdrawal: where its money can have come from.
 * Each deposit behind it is drawn with its share of the withdrawal, which
 * the notes between them bound (src/graph/sources.ts); the transactions in
 * between are left out. Deposits that can have supplied less than a cent
 * are drawn as one faint node.
 */
export function SourcesGraph({
  graph,
  burn,
  onSelect,
}: {
  graph: Graph
  /** the withdrawal's Payy tx */
  burn: string
  onSelect: (hash: string) => void
}) {
  const [box, width] = useWidth()
  const withdrawal = graph.withdrawals.find((w) => w.txHash === burn)
  const text = useAddressText([
    ...(graph.senders ?? []).map((g) => g.address),
    ...(withdrawal ? [withdrawal.recipient] : []),
  ])
  if (!withdrawal) return null
  const sources = sourcesOf(graph, withdrawal, text, onSelect)
  const steps = graph.txns.filter(
    (t) => t.kind === 1 && t.reach !== undefined && t.reach >= DUST,
  ).length
  return (
    <div ref={box} className="w-full">
      <Flow
        items={sources}
        width={width}
        label="Sources of the withdrawal"
        anchor={{
          title: `Withdrawal ${usdc(withdrawal.amount)}`,
          detail: `to ${text(withdrawal.recipient)} · ${date(withdrawal.time).slice(0, 10)}`,
          color: 'var(--withdrawal)',
          amount: withdrawal.amount,
        }}
      />
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        {sources.reduce((a, x) => a + x.min, 0) >= withdrawal.amount
          ? 'All of it provably came from the deposits shown; the transactions in between are left out. '
          : graph.truncated
            ? `More than ${graph.txns.length} transactions on Payy lie behind it, left out here. `
            : `${steps} transaction${steps === 1 ? '' : 's'} on Payy in between, left out here. `}
        Line widths show how much of the withdrawal can have come from each
        source.
      </p>
    </div>
  )
}

/** The sources to draw by sender, largest share first */
function sourcesOf(
  graph: Graph,
  w: Withdrawal,
  text: (a: string) => string,
  onSelect: (hash: string) => void,
): Source[] {
  const senders = graph.senders ?? []
  const size = (g: Sender) => g.share.max ?? g.share.min
  const real = senders.filter(
    (g) => g.share.max === undefined || g.share.max >= DUST,
  )
  const dust = senders.filter(
    (g) => g.share.max !== undefined && g.share.max < DUST,
  )
  const deposits = (g: Sender) =>
    graph.deposits.filter((d) => senderOf(d).toLowerCase() === g.address)
  // nothing bounded: one node says more than a fan of question marks
  if (graph.truncated && !real.some((g) => g.share.min >= DUST)) {
    return [
      {
        key: 'mixed',
        title: `${graph.deposits.length}+ deposits in this view`,
        detail: `by ${senders.length}+ senders; the history goes further back`,
        min: 0,
      },
    ]
  }
  const sorted = [...real].sort((a, b) => size(b) - size(a))
  const shown = sorted.slice(0, SHOWN)
  const rest = sorted.slice(SHOWN)
  const day = (t: number) => date(t).slice(0, 10)
  const sources: Source[] = shown.map((g) => {
    const [only] = g.deposits === 1 ? deposits(g) : []
    return {
      key: g.address,
      title:
        g.deposits === 1
          ? `Deposit ${usdc(g.amount)}`
          : `${g.deposits} deposits · ${usdc(g.amount)}`,
      detail: `${text(g.address)}${g.chain ? ` · ${originName(g.chain)}` : ''}${g.paid ? ' · grouped by who paid in' : ''} · ${day(g.first) === day(g.last) ? day(g.first) : `${day(g.first)} – ${day(g.last)}`}`,
      min: g.share.min,
      max: g.share.max,
      onClick: only ? () => onSelect(only.txHash) : undefined,
    }
  })
  if (rest.length > 0) {
    const max = rest.every((g) => g.share.max !== undefined)
      ? Math.min(
          w.amount,
          rest.reduce((a, g) => a + (g.share.max ?? 0), 0),
        )
      : undefined
    sources.push({
      key: 'rest',
      title: `${rest.reduce((a, g) => a + g.deposits, 0)} more deposits`,
      detail: `by ${rest.length} more senders, each a smaller share`,
      min: rest.reduce((a, g) => a + g.share.min, 0),
      max,
    })
  }
  // notes from the migration: what they can have put in is their reach
  const migrated = graph.notes.filter((n) => n.source === 'migration')
  if (migrated.length > 0) {
    const reach = migrated.reduce((a, n) => a + (n.reach ?? 0), 0)
    const known = migrated.every((n) => n.reach !== undefined)
    if (!known || reach >= DUST) {
      sources.push({
        key: 'migration',
        title: 'Migrated balances',
        detail: `${migrated.length} note${migrated.length === 1 ? '' : 's'} re-issued 2025-09-12`,
        min: 0,
        max: known ? Math.min(w.amount, reach) : undefined,
      })
    }
  }
  // unseen history matters only while the shown sources can fall short
  const covered = sources.reduce((a, x) => a + x.min, 0)
  if (graph.truncated && covered < w.amount) {
    sources.push({
      key: 'beyond',
      title: 'Further back',
      detail: 'history larger than this view',
      min: 0,
      max: undefined,
      faint: true,
    })
  }
  if (dust.length > 0) {
    const n = dust.reduce((a, g) => a + g.deposits, 0)
    sources.push({
      key: 'dust',
      title: `${n} deposit${n === 1 ? '' : 's'}`,
      detail:
        n === 1
          ? 'under a cent of it can have reached the withdrawal'
          : 'under a cent of each can have reached the withdrawal',
      min: 0,
      max: dust.reduce((a, g) => a + (g.share.max ?? 0), 0),
      faint: true,
    })
  }
  return sources
}

const NODE_H = 44
const GAP = 12

/** The node the others connect to: the withdrawal, or the deposit */
interface Anchor {
  title: string
  detail: string
  color: string
  amount: number
}

/** Stroke width for a share of the anchor */
function stroke(s: Source, total: number): number {
  const v = s.max ?? s.min
  if (s.max === undefined && s.min === 0) return 1.5
  return 1.5 + 12 * Math.min(1, v / Math.max(1, total))
}

/** The graph, left to right on wide screens and top to bottom on narrow */
function Flow({
  items,
  anchor,
  out,
  width,
  label,
}: {
  items: Source[]
  anchor: Anchor
  /** the anchor is where the money starts (a deposit), not where it ends */
  out?: boolean
  width: number
  label: string
}) {
  const color = out ? 'var(--withdrawal)' : 'var(--deposit)'
  return width < NARROW ? (
    <Vertical
      items={items}
      anchor={anchor}
      out={out}
      width={width}
      color={color}
      label={label}
    />
  ) : (
    <Horizontal
      items={items}
      anchor={anchor}
      out={out}
      width={width}
      color={color}
      label={label}
    />
  )
}

interface Drawing {
  items: Source[]
  anchor: Anchor
  out?: boolean
  width: number
  color: string
  label: string
}

function Horizontal({ items, anchor, out, width, color, label }: Drawing) {
  const nodeW = Math.min(240, width * 0.34)
  const height = Math.max(NODE_H + 2 * GAP, items.length * (NODE_H + GAP) + GAP)
  // items on the left and the anchor on the right, or the other way round
  const itemX = out ? width - nodeW - 2 : 1
  const anchorX = out ? 1 : width - nodeW - 2
  const ay = height / 2
  return (
    <svg width={width} height={height} role="img" aria-label={label}>
      {items.map((s, i) => {
        const y = GAP + i * (NODE_H + GAP)
        const iy = y + NODE_H / 2
        const [x1, y1, x2, y2] = out
          ? [anchorX + nodeW, ay, itemX, iy]
          : [itemX + nodeW, iy, anchorX, ay]
        const cx = (x1 + x2) / 2
        return (
          <g key={s.key} opacity={s.faint ? 0.4 : 1}>
            <path
              d={`M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={color}
              strokeOpacity={0.45}
              strokeWidth={stroke(s, anchor.amount)}
              strokeDasharray={s.max === undefined ? '4 4' : undefined}
            />
            <text
              x={out ? itemX - 8 : itemX + nodeW + 8}
              y={iy - 6}
              fontSize={11}
              fill="var(--ink-2)"
              className="mono"
              textAnchor={out ? 'end' : 'start'}
            >
              {between(s.min, s.max)}
            </text>
            <NodeBox
              x={itemX}
              y={y}
              w={nodeW}
              s={s}
              color={out ? 'var(--withdrawal)' : 'var(--deposit)'}
            />
          </g>
        )
      })}
      <AnchorNode x={anchorX} y={ay - NODE_H / 2} w={nodeW} anchor={anchor} />
    </svg>
  )
}

function Vertical({ items, anchor, out, width, color, label }: Drawing) {
  // boxes stacked on the right of a gutter the lines run down; the anchor
  // below them (money arriving) or above them (money leaving)
  const gutter = 18
  const nodeW = width - gutter - 2
  const stack = items.length * (NODE_H + GAP)
  const drop = 36
  const ay = out ? 0 : stack + drop
  const first = out ? NODE_H + drop : 0
  const height = out ? first + stack : ay + NODE_H + 2
  const ax = gutter + nodeW / 2
  return (
    <svg width={width} height={height} role="img" aria-label={label}>
      {items.map((s, i) => {
        const y = first + i * (NODE_H + GAP)
        const iy = y + NODE_H / 2
        const gx = 6 + (i % 4) * 2
        const d = out
          ? `M${ax},${NODE_H} L${gx + 10},${NODE_H + 6} Q${gx},${NODE_H + 4} ${gx},${NODE_H + 14} L${gx},${iy - 4} Q${gx},${iy} ${gx + 4},${iy} L${gutter},${iy}`
          : `M${gutter},${iy} L${gx + 4},${iy} Q${gx},${iy} ${gx},${iy + 4} L${gx},${ay - 14} Q${gx},${ay - 4} ${gx + 10},${ay - 6} L${ax},${ay}`
        return (
          <g key={s.key} opacity={s.faint ? 0.4 : 1}>
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeOpacity={0.45}
              strokeWidth={stroke(s, anchor.amount)}
              strokeDasharray={s.max === undefined ? '4 4' : undefined}
            />
            <NodeBox
              x={gutter}
              y={y}
              w={nodeW}
              s={s}
              share
              color={out ? 'var(--withdrawal)' : 'var(--deposit)'}
            />
          </g>
        )
      })}
      <AnchorNode x={gutter} y={ay} w={nodeW} anchor={anchor} />
    </svg>
  )
}

function NodeBox({
  x,
  y,
  w,
  s,
  share,
  color,
}: {
  x: number
  y: number
  w: number
  s: Source
  /** print the share in the box, where there is no room beside it */
  share?: boolean
  color: string
}) {
  const body = (
    <>
      <rect
        width={w}
        height={NODE_H}
        rx={6}
        fill="var(--surface)"
        stroke="var(--border)"
      />
      <rect
        width={4}
        height={NODE_H}
        rx={2}
        fill={s.faint ? 'var(--muted)' : color}
      />
      <text
        x={12}
        y={17}
        fontSize={12}
        fill="var(--ink)"
        className="mono"
        fontWeight={600}
      >
        {s.title}
      </text>
      {share && (
        <text
          x={w - 8}
          y={17}
          fontSize={11}
          fill="var(--ink-2)"
          className="mono"
          textAnchor="end"
        >
          {between(s.min, s.max)}
        </text>
      )}
      <text x={12} y={33} fontSize={11} fill="var(--muted)">
        {clip(s.detail, Math.floor((w - 16) / 6))}
      </text>
    </>
  )
  const open = s.onClick
  if (!open) return <g transform={`translate(${x} ${y})`}>{body}</g>
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
    <g
      transform={`translate(${x} ${y})`}
      className="cursor-pointer"
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      role="button"
      tabIndex={0}
    >
      {body}
    </g>
  )
}

function AnchorNode({
  x,
  y,
  w,
  anchor,
}: {
  x: number
  y: number
  w: number
  anchor: Anchor
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect
        width={w}
        height={NODE_H}
        rx={6}
        fill="var(--surface)"
        stroke="var(--ink)"
        strokeWidth={1.5}
      />
      <rect width={4} height={NODE_H} rx={2} fill={anchor.color} />
      <text
        x={12}
        y={17}
        fontSize={12}
        fill="var(--ink)"
        className="mono"
        fontWeight={600}
      >
        {anchor.title}
      </text>
      <text x={12} y={33} fontSize={11} fill="var(--muted)">
        {clip(anchor.detail, Math.floor((w - 16) / 6))}
      </text>
    </g>
  )
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(([e]) => {
      if (e) setWidth(e.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [box, width]
}

/**
 * The simple view of one deposit: where its money can have gone. Each
 * recipient ahead of it is drawn with how much of its withdrawals can have
 * come from the deposit; card payments and what is still unspent at most.
 */
export function SpreadGraph({
  graph,
  mint,
  onSelect,
}: {
  graph: Graph
  /** the deposit's Payy tx */
  mint: string
  onSelect: (hash: string) => void
}) {
  const [box, width] = useWidth()
  const deposit = graph.deposits.find((d) => d.txHash === mint)
  const text = useAddressText([
    ...(graph.recipients ?? []).map((r) => r.address),
    ...(deposit ? [senderOf(deposit)] : []),
  ])
  if (!deposit) return null
  const items = spreadItems(graph, deposit, text, onSelect)
  return (
    <div ref={box} className="w-full">
      <Flow
        items={items}
        out
        width={width}
        label="Where the deposit went"
        anchor={{
          title: `Deposit ${usdc(deposit.amount)}`,
          detail: `${text(senderOf(deposit))}${deposit.bridge ? ` · ${originName(deposit.bridge.chain)}` : ''} · ${date(deposit.time).slice(0, 10)}`,
          color: 'var(--deposit)',
          amount: deposit.amount,
        }}
      />
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        {graph.spread?.truncated
          ? `More than ${graph.txns.length} transactions follow it, so only lower bounds are shown. `
          : 'The transactions in between are left out. '}
        Line widths show how much of the deposit can have gone each way.
      </p>
    </div>
  )
}

function spreadItems(
  graph: Graph,
  d: Deposit,
  text: (a: string) => string,
  onSelect: (hash: string) => void,
): Source[] {
  const recipients = graph.recipients ?? []
  const real = recipients.filter(
    (r) => r.share.max === undefined || r.share.max >= DUST,
  )
  const dust = recipients.filter(
    (r) => r.share.max !== undefined && r.share.max < DUST,
  )
  const day = (t: number) => date(t).slice(0, 10)
  const items: Source[] = real.slice(0, SHOWN).map((r) => ({
    key: r.address,
    title:
      r.withdrawals === 1
        ? `Withdrawal ${usdc(r.amount)}`
        : `${r.withdrawals} withdrawals · ${usdc(r.amount)}`,
    detail: `to ${text(r.address)} · ${day(r.first) === day(r.last) ? day(r.first) : `${day(r.first)} – ${day(r.last)}`}`,
    min: r.share.min,
    max: r.share.max,
    onClick: r.burnTx ? () => onSelect(r.burnTx ?? '') : undefined,
  }))
  const rest = real.slice(SHOWN)
  if (rest.length > 0) {
    items.push({
      key: 'rest',
      title: `${rest.reduce((a, r) => a + r.withdrawals, 0)} more withdrawals`,
      detail: `to ${rest.length} more recipients`,
      min: rest.reduce((a, r) => a + r.share.min, 0),
      max: rest.every((r) => r.share.max !== undefined)
        ? Math.min(
            d.amount,
            rest.reduce((a, r) => a + (r.share.max ?? 0), 0),
          )
        : undefined,
    })
  }
  const s = graph.spread
  if (s?.card !== undefined && s.card >= DUST) {
    items.push({
      key: 'card',
      title: 'Card payments',
      detail: 'settled in Payy card batches',
      min: 0,
      max: s.card,
    })
  }
  if (s?.unspent !== undefined && s.unspent >= DUST) {
    items.push({
      key: 'unspent',
      title: 'Still on Payy',
      detail: 'in notes nobody has spent yet',
      min: 0,
      max: s.unspent,
    })
  }
  if (s?.truncated) {
    items.push({
      key: 'beyond',
      title: 'Further on',
      detail: 'more than this view',
      min: 0,
      faint: true,
    })
  }
  if (dust.length > 0) {
    const n = dust.reduce((a, r) => a + r.withdrawals, 0)
    items.push({
      key: 'dust',
      title: `${n} withdrawal${n === 1 ? '' : 's'}`,
      detail: 'under a cent of the deposit can have reached each',
      min: 0,
      max: dust.reduce((a, r) => a + (r.share.max ?? 0), 0),
      faint: true,
    })
  }
  return items
}
