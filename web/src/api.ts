import type { AddressSummary, Graph, Path, Status } from '../../src/graph/types'

export type Resolved =
  | { type: 'address'; address: string }
  | { type: 'txn'; hash: string }
  | { type: 'note'; commitment: string; createdTx?: string; spentTx?: string }
  | { type: 'unknown' }

export type Direction = 'back' | 'forward' | 'both'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export const api = {
  status: () => get<Status>('/api/status'),
  search: (q: string) => get<Resolved>(`/api/search/${encodeURIComponent(q)}`),
  address: (a: string) => get<AddressSummary>(`/api/address/${a}`),
  path: (burnTx: string) => get<Path>(`/api/path/${burnTx}`),
  graph: (txs: string[], dir: Direction) => {
    const params = new URLSearchParams()
    for (const tx of txs) params.append('tx', tx)
    params.set('dir', dir)
    return get<Graph>(`/api/graph?${params}`)
  },
}
