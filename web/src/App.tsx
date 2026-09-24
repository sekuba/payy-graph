import { useEffect, useState } from 'react'
import type {
  AddressSummary,
  Graph,
  Path,
  Resolved,
  Status,
} from '../../src/graph/types'
import { Address } from './Address'
import { api, type Direction } from './api'
import { OwnerNote } from './Bridge'
import { usdc } from './format'
import { GraphView } from './GraphView'
import { Keys } from './Keys'
import { Live } from './Live'
import { DepositPanel, PathPanel } from './PathPanel'
import { SourcesGraph, SpreadGraph } from './SourcesGraph'
import { DepositTable, WithdrawalTable } from './Tables'

/** Withdrawals of an address shown at first; the rest can be toggled on */
const INITIAL_WITHDRAWALS = 1
/** Graph sizes offered one after the other when a graph is truncated */
const LIMITS = [400, 1000, 2000]
/** The query that shows the page on whose keys spend the notes (#keys) */
const KEYS_PAGE = 'keys'

/**
 * One page: a search box, the graph, and the tables behind it. The URL hash
 * holds the query so views can be shared.
 */
export function App() {
  const [query, setQuery] = useState(() =>
    decodeURIComponent(location.hash.slice(1)),
  )
  const [input, setInput] = useState(query)
  const [status, setStatus] = useState<Status>()
  const [resolved, setResolved] = useState<Resolved>()
  const [summary, setSummary] = useState<AddressSummary>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [direction, setDirection] = useState<Direction>('back')
  const [graph, setGraph] = useState<Graph>()
  const [view, setView] = useState<'sources' | 'transactions'>('sources')
  const [limit, setLimit] = useState(0)
  const [paths, setPaths] = useState<Path[]>([])
  const [error, setError] = useState<string>()
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => setOffline(true))
  }, [])

  // Resolve the query into an address or a set of transactions
  useEffect(() => {
    location.hash = query ? encodeURIComponent(query) : ''
    setSummary(undefined)
    setGraph(undefined)
    setError(undefined)
    if (!query || query === KEYS_PAGE) {
      setResolved(undefined)
      return
    }
    let cancelled = false
    api
      .search(query)
      .then(async (r) => {
        if (cancelled) return
        setResolved(r)
        if (r.type === 'address') {
          const s = await api.address(r.address)
          if (cancelled) return
          setSummary(s)
          // the latest few; an address can have thousands of withdrawals
          setSelected(
            new Set(
              s.withdrawals.slice(-INITIAL_WITHDRAWALS).map((w) => w.txHash),
            ),
          )
          setDirection('back')
        } else if (r.type === 'txn') {
          setSelected(new Set([r.hash]))
          setDirection('both')
        } else if (r.type === 'note') {
          const start = r.spentTx ?? r.createdTx
          setSelected(new Set(start ? [start] : []))
          setDirection('back')
        }
      })
      .catch((e: unknown) => setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [query])

  // A new selection starts from the smallest graph again
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on change
  useEffect(() => setLimit(0), [selected, direction])

  // Load the graph for the selected transactions
  useEffect(() => {
    if (selected.size === 0) {
      setGraph(undefined)
      return
    }
    let cancelled = false
    api
      .graph([...selected], direction, LIMITS[limit])
      .then((g) => !cancelled && setGraph(g))
      .catch((e: unknown) => setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [selected, direction, limit])

  // The story of each selected withdrawal (at most a few at once), or of
  // the searched transaction if it is one
  useEffect(() => {
    const burns = summary
      ? summary.withdrawals
          .filter((w) => selected.has(w.txHash))
          .map((w) => w.txHash)
      : resolved?.type === 'txn'
        ? [resolved.hash]
        : []
    if (burns.length === 0) {
      setPaths([])
      return
    }
    let cancelled = false
    Promise.all(
      burns.slice(0, 3).map((h) => api.path(h).catch(() => undefined)),
    )
      .then((p) => !cancelled && setPaths(p.filter((x) => x !== undefined)))
      .catch((e: unknown) => setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [summary, resolved, selected])

  const toggle = (txHash: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(txHash)) next.delete(txHash)
      else next.add(txHash)
      return next
    })

  return (
    <div className="flex h-full flex-col gap-3 p-2 sm:p-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="whitespace-nowrap font-semibold">
          <a
            href="./"
            onClick={(e) => {
              e.preventDefault()
              setQuery('')
              setInput('')
            }}
          >
            Payy explorer
          </a>
        </h1>
        <form
          className="order-last w-full sm:order-none sm:w-auto sm:flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            setQuery(input.trim())
          }}
        >
          <input
            className="search mono"
            placeholder="Address, ENS name, Payy transaction or note"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
        </form>
        {status && query && <SyncStatus status={status} />}
        <span className="flex-1 sm:hidden" />
        <nav
          className="flex gap-3 whitespace-nowrap text-xs"
          style={{ color: 'var(--muted)' }}
        >
          <a
            href={`#${KEYS_PAGE}`}
            onClick={(e) => {
              e.preventDefault()
              setQuery(KEYS_PAGE)
              setInput('')
            }}
            style={query === KEYS_PAGE ? { color: 'var(--ink)' } : undefined}
          >
            who holds the keys
          </a>
          <a
            href="https://l2beat.com/privacy/projects/payy"
            target="_blank"
            rel="noreferrer"
          >
            L2BEAT
          </a>
          <a
            href="https://github.com/sekuba/payy-graph"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>
      </header>

      {offline && (
        <div style={{ color: 'var(--negative)' }}>
          The indexer is offline right now. Try again in a few minutes.
        </div>
      )}
      {error && !offline && (
        <div style={{ color: 'var(--negative)' }}>{error}</div>
      )}
      {!query && !offline && <Live onSelect={setQuery} />}
      {query === KEYS_PAGE && !offline && (
        <Keys
          onSelect={(q) => {
            setQuery(q)
            setInput(q)
          }}
        />
      )}

      {resolved?.type === 'unknown' && (
        <div style={{ color: 'var(--ink-2)' }}>
          {resolved.name
            ? `No address named ${resolved.name} has deposited into or withdrawn from Payy (names are matched against the primary name set for an address).`
            : 'Nothing in the index matches this input.'}
        </div>
      )}

      {summary && (
        <section className="card p-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
            <span className="mono break-all">{summary.address}</span>
            <Address address={summary.address} quiet />
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {plural(summary.withdrawals.length, 'withdrawal')} ·{' '}
              {plural(summary.deposits.length, 'deposit')}
            </span>
          </div>
          <Links summary={summary} />
          {summary.withdrawals.length > 0 && (
            <WithdrawalTable
              withdrawals={[...summary.withdrawals].reverse()}
              selected={selected}
              onToggle={toggle}
            />
          )}
          {summary.deposits.length > 0 && (
            <div className="mt-3">
              <DepositTable deposits={summary.deposits} />
            </div>
          )}
        </section>
      )}

      {paths.map((p) => (
        <PathPanel key={p.withdrawal.txHash} path={p} />
      ))}

      {graph && spreadOf(graph, selected) && (
        <DepositPanel graph={graph} mint={spreadOf(graph, selected) ?? ''} />
      )}

      {graph && (
        <>
          {(sourcesOf(graph, selected) || spreadOf(graph, selected)) && (
            <div className="flex gap-1 text-xs">
              {(['sources', 'transactions'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`toggle ${view === v ? 'on' : ''}`}
                  onClick={() => setView(v)}
                >
                  {v === 'sources'
                    ? sourcesOf(graph, selected)
                      ? 'where it came from'
                      : 'where it went'
                    : 'all transactions'}
                </button>
              ))}
            </div>
          )}
          {sourcesOf(graph, selected) && view === 'sources' ? (
            <section className="card p-3">
              <SourcesGraph
                graph={graph}
                burn={sourcesOf(graph, selected) ?? ''}
                onSelect={(h) => setQuery(h)}
              />
            </section>
          ) : spreadOf(graph, selected) && view === 'sources' ? (
            <section className="card p-3">
              <SpreadGraph
                graph={graph}
                mint={spreadOf(graph, selected) ?? ''}
                onSelect={(h) => setQuery(h)}
              />
            </section>
          ) : (
            <section className="card relative min-h-[420px] flex-1">
              <div className="absolute top-3 left-3 z-10 flex gap-1 text-xs">
                {(['back', 'both', 'forward'] as Direction[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`toggle ${direction === d ? 'on' : ''}`}
                    onClick={() => setDirection(d)}
                  >
                    {d === 'back'
                      ? 'to deposits'
                      : d === 'forward'
                        ? 'to withdrawals'
                        : 'both'}
                  </button>
                ))}
              </div>
              <GraphView
                graph={graph}
                focus={selected}
                onSelect={(h) => setQuery(h)}
                onMore={
                  limit < LIMITS.length - 1
                    ? () => setLimit((l) => l + 1)
                    : undefined
                }
              />
            </section>
          )}
          <details className="card p-3">
            <summary
              className="cursor-pointer text-xs"
              style={{ color: 'var(--ink-2)' }}
            >
              {plural(graph.deposits.length, 'deposit')} and{' '}
              {plural(graph.withdrawals.length, 'withdrawal')} in this view
            </summary>
            <div className="mt-2">
              <DepositTable deposits={graph.deposits} />
            </div>
            {graph.withdrawals.length > 0 && (
              <div className="mt-3">
                <WithdrawalTable withdrawals={graph.withdrawals} />
              </div>
            )}
          </details>
        </>
      )}
    </div>
  )
}

/**
 * The withdrawal a sources view can be drawn for: exactly one selected,
 * and the graph gives shares for it
 */
function sourcesOf(graph: Graph, selected: Set<string>): string | undefined {
  if (selected.size !== 1) return undefined
  const [burn] = selected
  const w = graph.withdrawals.find((x) => x.txHash === burn)
  return w && graph.deposits.some((d) => d.share) ? w.txHash : undefined
}

/**
 * Who an address is linked to through its withdrawals: the senders whose
 * deposits provably supplied them, and the recipients of withdrawals its
 * own deposits supplied (from the stored traces)
 */
function Links({ summary }: { summary: AddressSummary }) {
  const own = summary.address.toLowerCase()
  const line = (label: string, links: AddressSummary['funded']) =>
    links.length > 0 && (
      <div className="text-sm">
        <span style={{ color: 'var(--muted)' }}>{label} </span>
        {links.map((l, i) => (
          <span key={l.address}>
            {i > 0 && <span style={{ color: 'var(--muted)' }}> · </span>}
            {l.address === own ? (
              <span className="chip chip-strong">itself</span>
            ) : (
              <Address address={l.address} />
            )}
            <span className="mono" style={{ color: 'var(--muted)' }}>
              {' '}
              {l.withdrawals === 1 ? '' : `${l.withdrawals}× `}≥{' '}
              {usdc(l.amount)}
            </span>
          </span>
        ))}
      </div>
    )
  const by = line('withdrawals funded by', summary.fundedBy)
  const to = line('deposits funded withdrawals to', summary.funded)
  const group = (summary.addresses ?? []).length > 0 && (
    <div className="text-sm">
      <span style={{ color: 'var(--muted)' }}>its Payy addresses </span>
      {(summary.addresses ?? []).slice(0, 6).map((a, i) => (
        <span key={a}>
          {i > 0 && <span style={{ color: 'var(--muted)' }}> · </span>}
          <Address address={a} />
        </span>
      ))}
      {(summary.addresses ?? []).length > 6 && (
        <span style={{ color: 'var(--muted)' }}>
          {' '}
          and {(summary.addresses ?? []).length - 6} more
        </span>
      )}
      {summary.owner?.paid && (
        <span style={{ color: 'var(--muted)' }}>
          {' · '}
          <OwnerNote
            addresses={summary.addresses ?? []}
            root={summary.owner.address}
          />
        </span>
      )}
    </div>
  )
  if (!by && !to && !group) return null
  return (
    <div
      className="mb-3 grid gap-1"
      title="From the traced withdrawals: a sender counts when its deposits provably supplied at least a cent of a withdrawal"
    >
      {group}
      {by}
      {to}
    </div>
  )
}

/** The deposit a "where it went" view can be drawn for */
function spreadOf(graph: Graph, selected: Set<string>): string | undefined {
  if (selected.size !== 1 || !graph.recipients) return undefined
  const [mint] = selected
  return graph.deposits.find((d) => d.txHash === mint)?.txHash
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
}

function SyncStatus({ status }: { status: Status }) {
  return (
    <div
      className="hidden whitespace-nowrap text-xs sm:block"
      style={{ color: 'var(--muted)' }}
    >
      {status.txns.toLocaleString('en-US')} txns · height{' '}
      {status.payyHeight?.toLocaleString('en-US') ?? '–'}
    </div>
  )
}
