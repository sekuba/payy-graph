import { type Db, getSync, setSync, transaction } from '../db'
import { log, sleep } from '../log'
import { type ChainInfo, TOPICS } from '../protocol'
import {
  addressTopic,
  decodeBurned,
  decodeMintAdded,
  decodeRollupVerified,
  decodeTransfer,
  ROLLUP_TOPICS,
} from './events'
import type { JsonRpc, Log } from './rpc'

const CHUNK_BLOCKS: Record<string, number> = {
  ethereum: 50_000,
  polygon: 100_000,
}
/** Distance between sampled block timestamps used for interpolation */
const TIME_ANCHOR_BLOCKS = 2_000

/**
 * Indexes the Rollup's deposits, withdrawals and state updates on one chain.
 * Deposits are joined with the USDC transfer into the Rollup from the same
 * transaction, which gives the depositor for both mint() and
 * mintWithAuthorization() without decoding calldata.
 */
export async function syncChain(
  db: Db,
  chain: ChainInfo,
  rpc: JsonRpc,
  options: { follow: boolean },
): Promise<void> {
  const key = `l1_${chain.id}_block`
  const chunk = CHUNK_BLOCKS[chain.id] ?? 50_000
  for (;;) {
    const from = Number(getSync(db, key) ?? chain.fromBlock - 1) + 1
    const head = (await rpc.getBlockNumber()) - chain.confirmations
    if (from > head) {
      if (!options.follow) break
      await sleep(30_000)
      continue
    }
    const to = Math.min(from + chunk - 1, head)
    await indexRange(db, chain, rpc, from, to)
    setSync(db, key, String(to))
    log(`${chain.id} sync`, { from, to, head })
  }
}

async function indexRange(
  db: Db,
  chain: ChainInfo,
  rpc: JsonRpc,
  from: number,
  to: number,
): Promise<void> {
  const [rollupLogs, usdcIn, timeOf] = await Promise.all([
    rpc.getLogs({
      address: chain.rollup,
      topics: [ROLLUP_TOPICS],
      fromBlock: from,
      toBlock: to,
    }),
    rpc.getLogs({
      address: chain.usdc,
      topics: [TOPICS.Transfer, null, addressTopic(chain.rollup)],
      fromBlock: from,
      toBlock: to,
    }),
    blockTimes(db, chain, rpc, from, to),
  ])

  // USDC transfers into the Rollup by tx, in log order
  const transfersByTx = new Map<string, Log[]>()
  for (const l of usdcIn) {
    const list = transfersByTx.get(l.transactionHash) ?? []
    list.push(l)
    transfersByTx.set(l.transactionHash, list)
  }

  const insertDeposit = db.prepare(
    `insert into deposit (chain, mint_hash, block, tx, log_index, time, depositor, amount)
     values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  const insertBurned = db.prepare(
    `insert into burned (chain, tx, log_index, block, time, burn_hash, recipient, substitute, success)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  const insertSettlement = db.prepare(
    `insert into settlement (chain, height, block, tx, time, root)
     values (?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )

  transaction(db, () => {
    for (const l of rollupLogs) {
      const time = timeOf(l.blockNumber)
      switch (l.topics[0]) {
        case TOPICS.MintAdded: {
          const mint = decodeMintAdded(l)
          // The transfer that paid for this mint is the closest earlier
          // USDC transfer into the Rollup in the same tx (a tx may batch
          // several deposits).
          const transfers = transfersByTx.get(l.transactionHash) ?? []
          const paid = transfers.filter((t) => t.logIndex < l.logIndex).pop()
          if (!paid) {
            throw new Error(`deposit without transfer: ${l.transactionHash}`)
          }
          transfers.splice(transfers.indexOf(paid), 1)
          const transfer = decodeTransfer(paid)
          insertDeposit.run(
            chain.id,
            mint.mintHash,
            l.blockNumber,
            l.transactionHash,
            l.logIndex,
            time,
            transfer.from,
            mint.amount,
          )
          break
        }
        case TOPICS.Burned: {
          const b = decodeBurned(l)
          insertBurned.run(
            chain.id,
            l.transactionHash,
            l.logIndex,
            l.blockNumber,
            time,
            b.burnHash,
            b.recipient,
            b.substitute ? 1 : 0,
            b.success ? 1 : 0,
          )
          break
        }
        case TOPICS.RollupVerified: {
          const s = decodeRollupVerified(l)
          insertSettlement.run(
            chain.id,
            s.height,
            l.blockNumber,
            l.transactionHash,
            time,
            s.root,
          )
          break
        }
      }
    }
  })
}

/**
 * Fetches timestamps for every TIME_ANCHOR_BLOCKS-th block of the range plus
 * both ends, stores them, and returns a linear interpolation function. This
 * dates events to within seconds on Ethereum and about a minute on Polygon,
 * at a tiny fraction of the cost of fetching every block.
 */
async function blockTimes(
  db: Db,
  chain: ChainInfo,
  rpc: JsonRpc,
  from: number,
  to: number,
): Promise<(block: number) => number> {
  const wanted: number[] = [from]
  for (
    let b = Math.ceil(from / TIME_ANCHOR_BLOCKS) * TIME_ANCHOR_BLOCKS;
    b < to;
    b += TIME_ANCHOR_BLOCKS
  ) {
    if (b > from) wanted.push(b)
  }
  wanted.push(to)
  const times = await rpc.getBlockTimestamps(wanted)
  const insert = db.prepare(
    'insert into block_time (chain, block, time) values (?, ?, ?) on conflict do nothing',
  )
  transaction(db, () => {
    for (const [block, time] of times) insert.run(chain.id, block, time)
  })
  const anchors = [...times.entries()].sort((a, b) => a[0] - b[0])
  return (block) => {
    let i = 0
    while (i + 1 < anchors.length && (anchors[i + 1]?.[0] ?? 0) < block) i++
    const lo = anchors[i]
    const hi = anchors[i + 1]
    if (!lo) throw new Error('no time anchors')
    if (!hi || hi[0] === lo[0]) return lo[1]
    const share = (block - lo[0]) / (hi[0] - lo[0])
    return Math.round(lo[1] + share * (hi[1] - lo[1]))
  }
}
