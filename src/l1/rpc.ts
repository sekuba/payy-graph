import { sleep } from '../log'

export interface Log {
  topics: string[]
  data: string
  blockNumber: number
  transactionHash: string
  logIndex: number
}

export interface LogFilter {
  address: string
  /** Each position is one topic or a list of alternatives; null = any */
  topics: (string | string[] | null)[]
  fromBlock: number
  toBlock: number
}

interface RawLog {
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: string
}

/** Minimal JSON-RPC client: only what the L1 indexer needs */
export class JsonRpc {
  constructor(private readonly url: string) {}

  async getBlockNumber(): Promise<number> {
    return Number(await this.call<string>('eth_blockNumber', []))
  }

  /**
   * Providers cap the size of a getLogs response. When a range is too dense
   * the request is split in half and retried, so callers can ask for large
   * ranges and stay simple.
   */
  async getLogs(filter: LogFilter): Promise<Log[]> {
    let raw: RawLog[]
    try {
      raw = await this.call<RawLog[]>('eth_getLogs', [
        {
          address: filter.address,
          topics: filter.topics,
          fromBlock: hex(filter.fromBlock),
          toBlock: hex(filter.toBlock),
        },
      ])
    } catch (e) {
      if (filter.fromBlock >= filter.toBlock || !isTooLarge(e)) throw e
      const mid = Math.floor((filter.fromBlock + filter.toBlock) / 2)
      const [a, b] = await Promise.all([
        this.getLogs({ ...filter, toBlock: mid }),
        this.getLogs({ ...filter, fromBlock: mid + 1 }),
      ])
      return [...a, ...b]
    }
    return raw.map((l) => ({
      topics: l.topics,
      data: l.data,
      blockNumber: Number(l.blockNumber),
      transactionHash: l.transactionHash,
      logIndex: Number(l.logIndex),
    }))
  }

  /** Timestamps of many blocks in one batched request */
  async getBlockTimestamps(blocks: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>()
    for (let i = 0; i < blocks.length; i += 100) {
      const batch = blocks.slice(i, i + 100)
      const responses = await this.batch<{ timestamp: string }>(
        batch.map((b) => ({
          method: 'eth_getBlockByNumber',
          params: [hex(b), false],
        })),
      )
      batch.forEach((b, j) => {
        const r = responses[j]
        if (r) result.set(b, Number(r.timestamp))
      })
    }
    return result
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const [result] = await this.batch<T>([{ method, params }])
    if (result === undefined) throw new Error(`empty response for ${method}`)
    return result
  }

  private async batch<T>(
    calls: { method: string; params: unknown[] }[],
  ): Promise<T[]> {
    const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const json = (await res.json()) as {
          id: number
          result?: T
          error?: { message: string }
        }[]
        const byId = new Map(json.map((r) => [r.id, r]))
        return calls.map((c, id) => {
          const r = byId.get(id)
          if (!r || r.error) {
            throw new Error(`${c.method}: ${r?.error?.message ?? 'missing'}`)
          }
          return r.result as T
        })
      } catch (e) {
        lastError = e
        if (isTooLarge(e)) break
        await sleep(1000 * 2 ** attempt)
      }
    }
    throw new Error(`rpc failed: ${String(lastError)}`)
  }
}

function isTooLarge(e: unknown): boolean {
  return /size exceeded|too many|limit|more than|range/i.test(String(e))
}

function hex(n: number): string {
  return `0x${n.toString(16)}`
}
