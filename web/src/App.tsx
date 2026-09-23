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
import { GraphView } from './GraphView'
import { Live } from './Live'
import { PathPanel } from './PathPanel'
import { DepositTable, WithdrawalTable } from './Tables'

/** Withdrawals of an address shown at first; the rest can be toggled on */
const INITIAL_WITHDRAWALS = 5
/** Graph sizes offered one after the other when a graph is truncated */
const LIMITS = [400, 1000, 2000]

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
    if (!query) {
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
            placeholder="L1 address, Payy transaction hash or note commitment"
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

      {resolved?.type === 'unknown' && (
        <div style={{ color: 'var(--ink-2)' }}>
          Nothing in the index matches this input.
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

      {graph && (
        <>
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
          <section className="card p-3">
            <DepositTable deposits={graph.deposits} />
            {graph.withdrawals.length > 0 && (
              <div className="mt-3">
                <WithdrawalTable withdrawals={graph.withdrawals} />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
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
