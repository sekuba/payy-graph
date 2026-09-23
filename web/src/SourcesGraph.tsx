import { useEffect, useRef, useState } from 'react'
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
      {width < NARROW ? (
        <Vertical
          sources={sources}
          withdrawal={withdrawal}
          text={text}
          width={width}
        />
      ) : (
        <Horizontal
          sources={sources}
          withdrawal={withdrawal}
          text={text}
          width={width}
        />
      )}
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

function senderOf(d: Deposit): string {
  return d.bridge?.funder?.address ?? d.bridge?.depositor ?? d.depositor
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
      detail: `${text(g.address)}${g.chain ? ` · ${originName(g.chain)}` : ''} · ${day(g.first) === day(g.last) ? day(g.first) : `${day(g.first)} – ${day(g.last)}`}`,
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

/** Stroke width for a share of the withdrawal */
function stroke(s: Source, total: number): number {
  const v = s.max ?? s.min
  if (s.max === undefined && s.min === 0) return 1.5
  return 1.5 + 12 * Math.min(1, v / Math.max(1, total))
}

function Horizontal({
  sources,
  withdrawal,
  text,
  width,
}: {
  sources: Source[]
  withdrawal: Withdrawal
  text: (a: string) => string
  width: number
}) {
  const nodeW = Math.min(240, width * 0.34)
  const height = Math.max(
    NODE_H + 2 * GAP,
    sources.length * (NODE_H + GAP) + GAP,
  )
  const wx = width - nodeW - 2
  const wy = height / 2 - NODE_H / 2
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Sources of the withdrawal"
    >
      {sources.map((s, i) => {
        const y = GAP + i * (NODE_H + GAP)
        const x1 = nodeW + 2
        const y1 = y + NODE_H / 2
        const x2 = wx
        const y2 = height / 2
        const cx = (x1 + x2) / 2
        return (
          <g key={s.key} opacity={s.faint ? 0.4 : 1}>
            <path
              d={`M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`}
              fill="none"
              stroke="var(--deposit)"
              strokeOpacity={0.45}
              strokeWidth={stroke(s, withdrawal.amount)}
              strokeDasharray={s.max === undefined ? '4 4' : undefined}
            />
            <text
              x={x1 + 8}
              y={y1 - 6}
              fontSize={11}
              fill="var(--ink-2)"
              className="mono"
            >
              {between(s.min, s.max)}
            </text>
            <NodeBox x={1} y={y} w={nodeW} s={s} />
          </g>
        )
      })}
      <WithdrawalNode
        x={wx}
        y={wy}
        w={nodeW}
        withdrawal={withdrawal}
        text={text}
      />
    </svg>
  )
}

function Vertical({
  sources,
  withdrawal,
  text,
  width,
}: {
  sources: Source[]
  withdrawal: Withdrawal
  text: (a: string) => string
  width: number
}) {
  // boxes stacked on the right of a gutter the lines run down
  const gutter = 18
  const nodeW = width - gutter - 2
  const top = sources.length * (NODE_H + GAP)
  const wy = top + 36
  const height = wy + NODE_H + 2
  const x2 = gutter + nodeW / 2
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Sources of the withdrawal"
    >
      {sources.map((s, i) => {
        const y = i * (NODE_H + GAP)
        const y1 = y + NODE_H / 2
        const gx = 6 + (i % 4) * 2
        return (
          <g key={s.key} opacity={s.faint ? 0.4 : 1}>
            <path
              d={`M${gutter},${y1} L${gx + 4},${y1} Q${gx},${y1} ${gx},${y1 + 4} L${gx},${wy - 14} Q${gx},${wy - 4} ${gx + 10},${wy - 6} L${x2},${wy}`}
              fill="none"
              stroke="var(--deposit)"
              strokeOpacity={0.45}
              strokeWidth={stroke(s, withdrawal.amount)}
              strokeDasharray={s.max === undefined ? '4 4' : undefined}
            />
            <NodeBox x={gutter} y={y} w={nodeW} s={s} share />
          </g>
        )
      })}
      <WithdrawalNode
        x={gutter}
        y={wy}
        w={nodeW}
        withdrawal={withdrawal}
        text={text}
      />
    </svg>
  )
}

function NodeBox({
  x,
  y,
  w,
  s,
  share,
}: {
  x: number
  y: number
  w: number
  s: Source
  /** print the share in the box, where there is no room beside it */
  share?: boolean
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
        fill={s.faint ? 'var(--muted)' : 'var(--deposit)'}
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

function WithdrawalNode({
  x,
  y,
  w,
  withdrawal,
  text,
}: {
  x: number
  y: number
  w: number
  withdrawal: Withdrawal
  text: (a: string) => string
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
      <rect width={4} height={NODE_H} rx={2} fill="var(--withdrawal)" />
      <text
        x={12}
        y={17}
        fontSize={12}
        fill="var(--ink)"
        className="mono"
        fontWeight={600}
      >
        Withdrawal {usdc(withdrawal.amount)}
      </text>
      <text x={12} y={33} fontSize={11} fill="var(--muted)">
        {clip(
          `to ${text(withdrawal.recipient)} · ${date(withdrawal.time).slice(0, 10)}`,
          Math.floor((w - 16) / 6),
        )}
      </text>
    </g>
  )
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s
}
