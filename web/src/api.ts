import type {
  AddressSummary,
  Graph,
  Names,
  Path,
  Resolved,
  Status,
} from '../../src/graph/types'

export type Direction = 'back' | 'forward' | 'both'

/**
 * Where the API lives. Empty when the UI is served by the API server itself
 * (or proxied by Vite in development); the API's own origin when the UI is
 * hosted elsewhere, e.g. on GitHub Pages.
 */
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

async function get<T>(path: string): Promise<T> {
  const res = await fetch(API_URL + path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export const api = {
  status: () => get<Status>('/api/status'),
  search: (q: string) => get<Resolved>(`/api/search/${encodeURIComponent(q)}`),
  address: (a: string) => get<AddressSummary>(`/api/address/${a}`),
  path: (burnTx: string) => get<Path>(`/api/path/${burnTx}`),
  graph: (txs: string[], dir: Direction, limit?: number) => {
    const params = new URLSearchParams()
    for (const tx of txs) params.append('tx', tx)
    params.set('dir', dir)
    if (limit) params.set('limit', String(limit))
    return get<Graph>(`/api/graph?${params}`)
  },
  names: (addresses: string[]) => {
    const params = new URLSearchParams()
    for (const a of addresses) params.append('a', a)
    return get<Names>(`/api/names?${params}`)
  },
}
