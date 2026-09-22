import { expect } from 'earl'
import { openDb } from '../db'
import { CHAINS } from '../protocol'
import { syncChain } from './indexer'
import type { JsonRpc, Log, LogFilter } from './rpc'

/** RPC with no events whose head advances by one chunk per call */
class FakeRpc {
  blockLookups: number[][] = []
  constructor(private head: number) {}
  async getBlockNumber(): Promise<number> {
    return this.head
  }
  async getLogs(_filter: LogFilter): Promise<Log[]> {
    return []
  }
  async getBlockTimestamps(blocks: number[]): Promise<Map<number, number>> {
    this.blockLookups.push(blocks)
    return new Map(blocks.map((b) => [b, b * 12]))
  }
  advance(blocks: number): void {
    this.head += blocks
  }
}

describe('syncChain block timestamps', () => {
  it('reuses the previous range end as the lower anchor', async () => {
    const db = openDb(':memory:')
    const chain = { ...CHAINS.ethereum, fromBlock: 1000, confirmations: 0 }
    const rpc = new FakeRpc(4999)

    await syncChain(db, chain, rpc as unknown as JsonRpc, { follow: false })
    expect(rpc.blockLookups).toEqual([[1000, 2000, 4000, 4999]])

    rpc.advance(3)
    await syncChain(db, chain, rpc as unknown as JsonRpc, { follow: false })
    expect(rpc.blockLookups[1]).toEqual([5002])

    const stored = db
      .prepare('select block from block_time where chain = ? order by block')
      .all(chain.id)
      .map((r) => (r as { block: number }).block)
    expect(stored).toEqual([1000, 2000, 4000, 4999, 5002])
  })
})
