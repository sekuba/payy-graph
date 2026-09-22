import { useEffect, useState } from 'react'
import type { AddressSummary, Graph, Path, Status } from '../../src/graph/types'
import { api, type Direction, type Resolved } from './api'
import { GraphView } from './GraphView'
import { PathPanel } from './PathPanel'
import { DepositTable, WithdrawalTable } from './Tables'

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
  const [paths, setPaths] = useState<Path[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => undefined)
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
          setSelected(new Set(s.withdrawals.map((w) => w.txHash)))
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

  // Load the graph for the selected transactions
  useEffect(() => {
    if (selected.size === 0) {
      setGraph(undefined)
      return
    }
    let cancelled = false
    api
      .graph([...selected], direction)
      .then((g) => !cancelled && setGraph(g))
      .catch((e: unknown) => setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [selected, direction])

  // The story of each selected withdrawal (at most a few at once)
  useEffect(() => {
    const burns = (summary?.withdrawals ?? [])
      .filter((w) => selected.has(w.txHash))
      .slice(0, 3)
    if (burns.length === 0) {
      setPaths([])
      return
    }
    let cancelled = false
    Promise.all(burns.map((w) => api.path(w.txHash)))
      .then((p) => !cancelled && setPaths(p))
      .catch((e: unknown) => setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [summary, selected])

  const toggle = (txHash: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(txHash)) next.delete(txHash)
      else next.add(txHash)
      return next
    })

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="flex items-center gap-3">
        <h1 className="whitespace-nowrap font-semibold">Payy spend graph</h1>
        <form
          className="flex-1"
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
        {status && <SyncStatus status={status} />}
      </header>

      {error && <div style={{ color: 'var(--withdrawal)' }}>{error}</div>}
      {resolved?.type === 'unknown' && (
        <div style={{ color: 'var(--ink-2)' }}>
          Nothing in the index matches this input.
        </div>
      )}

      {summary && (
        <section className="card p-3">
          <div className="mb-2 flex items-baseline gap-3">
            <span className="mono">{summary.address}</span>
            {summary.label && <span className="chip">{summary.label}</span>}
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {summary.withdrawals.length} withdrawals ·{' '}
              {summary.deposits.length} deposits
            </span>
          </div>
          {summary.withdrawals.length > 0 && (
            <WithdrawalTable
              withdrawals={summary.withdrawals}
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

function SyncStatus({ status }: { status: Status }) {
  return (
    <div
      className="whitespace-nowrap text-xs"
      style={{ color: 'var(--muted)' }}
    >
      {status.txns.toLocaleString()} txns · height{' '}
      {status.payyHeight?.toLocaleString() ?? '–'}
    </div>
  )
}
