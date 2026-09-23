import { type Db, getSync, one, setSync, transaction } from '../db'
import { log, sleep } from '../log'
import { type ChainId, type ChainInfo, TOPICS } from '../protocol'
import type { JsonRpc, Log } from './rpc'

const CHUNK_BLOCKS: Record<ChainId, number> = {
  ethereum: 50_000,
  polygon: 100_000,
}
/** Distance between sampled block timestamps used for interpolation */
const TIME_ANCHOR_BLOCKS = 2_000
/**
 * How often follow mode looks for new confirmed blocks. Both chains already
 * lag by their confirmation depth, so two minutes adds little delay and
 * keeps the RPC request count low.
 */
const FOLLOW_POLL_MS = 120_000

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
  for (;;) {
    const from = Number(getSync(db, key) ?? chain.fromBlock - 1) + 1
    const head = (await rpc.getBlockNumber()) - chain.confirmations
    if (from > head) {
      if (!options.follow) break
      await sleep(FOLLOW_POLL_MS)
      continue
    }
    const to = Math.min(from + CHUNK_BLOCKS[chain.id] - 1, head)
    await indexRange(db, chain, rpc, from, to)
    setSync(db, key, String(to))
    log(`${chain.id} sync`, { from, to, head })
  }
}

/** 32-byte word `i` of the data field, hex without 0x */
function word(data: string, i: number): string {
  return data.slice(2 + 64 * i, 2 + 64 * (i + 1))
}

function topicHash(topic: string | undefined): string {
  if (!topic) throw new Error('missing topic')
  return topic.slice(2).toLowerCase()
}

function topicAddress(topic: string | undefined): string {
  return `0x${topicHash(topic).slice(24)}`
}

function toNumber(hexWord: string): number {
  return Number(BigInt(`0x${hexWord}`))
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
      topics: [[TOPICS.MintAdded, TOPICS.Burned, TOPICS.RollupVerified]],
      fromBlock: from,
      toBlock: to,
    }),
    rpc.getLogs({
      address: chain.usdc,
      topics: [
        TOPICS.Transfer,
        null,
        `0x${'0'.repeat(24)}${chain.rollup.slice(2)}`,
      ],
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
          // The transfer that paid for this mint is the closest earlier
          // USDC transfer into the Rollup in the same tx (a tx may batch
          // several deposits).
          const transfers = transfersByTx.get(l.transactionHash) ?? []
          const paid = transfers.filter((t) => t.logIndex < l.logIndex).pop()
          if (!paid) {
            throw new Error(`deposit without transfer: ${l.transactionHash}`)
          }
          transfers.splice(transfers.indexOf(paid), 1)
          insertDeposit.run(
            chain.id,
            topicHash(l.topics[1]),
            l.blockNumber,
            l.transactionHash,
            l.logIndex,
            time,
            topicAddress(paid.topics[1]),
            toNumber(word(l.data, 0)),
          )
          break
        }
        case TOPICS.Burned: {
          insertBurned.run(
            chain.id,
            l.transactionHash,
            l.logIndex,
            l.blockNumber,
            time,
            topicHash(l.topics[2]),
            topicAddress(l.topics[3]),
            toNumber(word(l.data, 0)),
            toNumber(word(l.data, 1)),
          )
          break
        }
        case TOPICS.RollupVerified: {
          insertSettlement.run(
            chain.id,
            toNumber(topicHash(l.topics[1])),
            l.blockNumber,
            l.transactionHash,
            time,
            word(l.data, 0),
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
 * at a tiny fraction of the cost of fetching every block. The block just
 * before the range is the previous range's end, whose time is already stored,
 * so it serves as the lower anchor without another request.
 */
async function blockTimes(
  db: Db,
  chain: ChainInfo,
  rpc: JsonRpc,
  from: number,
  to: number,
): Promise<(block: number) => number> {
  const stored = one<{ block: number; time: number }>(
    db,
    'select block, time from block_time where chain = ? and block = ?',
    chain.id,
    from - 1,
  )
  const wanted: number[] = stored ? [] : [from]
  for (
    let b = Math.ceil(from / TIME_ANCHOR_BLOCKS) * TIME_ANCHOR_BLOCKS;
    b < to;
    b += TIME_ANCHOR_BLOCKS
  ) {
    if (b > from) wanted.push(b)
  }
  wanted.push(to)
  const times = await rpc.getBlockTimestamps(wanted)
  if (stored) times.set(stored.block, stored.time)
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
