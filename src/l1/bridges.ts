import { all, type Db, getSync, one, setSync, transaction } from '../db'
import { deriveIdentities } from '../graph/identity'
import { log, sleep } from '../log'
import {
  ACROSS,
  CHAINS,
  type ChainId,
  ORIGIN_CHAINS,
  TOPICS,
} from '../protocol'
import type { JsonRpc, Log, ReceiptLog } from './rpc'

/**
 * Deposits bridged in from other chains (see ACROSS in protocol.ts), in two
 * steps, both from onchain data only:
 *
 * 1. On the settlement chain: the last USDC transfer into the depositor
 *    before the deposit. If it is an Across fill to the depositor of exactly
 *    the deposited amount, the fill names the origin chain and the address
 *    that deposited into Across there.
 * 2. On the origin chain, where an RPC is configured: the Across deposit the
 *    fill names (FundsDeposited, by its deposit id), what the origin
 *    depositor paid into it (often USDT, swapped by Across's periphery),
 *    and every transfer of that token into the origin depositor since its
 *    previous transfer out (looking back at most PAYER_LOOKBACK): who paid
 *    it. The Payy app keeps one such address per user.
 *
 * Deposits that did not come through a bridge get the transfer that funded
 * the deposit address just before, and the sender of that transaction:
 * when a swap router paid the deposit address, that is who swapped.
 *
 * Deposits are checked newest first, so new ones are covered at once and the
 * history is filled in batch by batch. Who belongs together is derived from
 * all of it afterwards (src/graph/identity.ts).
 */

/** How far before a deposit its funding transfer is looked for */
const WINDOW_BLOCKS: Record<ChainId, number> = {
  ethereum: 300,
  polygon: 1_800,
}
/** How long before a fill its Across deposit is looked for */
const BRIDGE_WINDOW_SECONDS = 3_600
/** How long before bridging payments into the origin address are looked for */
const PAYER_LOOKBACK_SECONDS = 3 * 24 * 3_600
/** Bumped when the payer lookup changes: every bridged deposit again */
const PAYERS_VERSION = 2
const PAYERS_KEY = 'bridge_payers_version'
/** Set once every deposit's funding has been looked up */
export const FUNDING_DONE_KEY = 'bridge_funding_done'
/** How often identities are derived again while new data comes in */
const IDENTITY_MS = 10 * 60_000
/** Deposits per getLogs request (one topic alternative each) */
const BATCH = 50
const FUNDERS_PER_ROUND = 40
const POLL_MS = 120_000

interface DepositRow {
  chain: ChainId
  mint_hash: string
  block: number
  tx: string
  log_index: number
  time: number
  depositor: string
  amount: number
}

export interface BridgeRow {
  chain: ChainId
  mint_hash: string
  fill_tx: string | null
  origin_chain: number | null
  deposit_id: string | null
  origin_depositor: string | null
  origin_tx: string | null
  origin_time: number | null
  origin_token: string | null
  origin_amount: string | null
  funder: string | null
  funder_tx: string | null
  funder_amount: string | null
  funder_time: number | null
  funder_checked: number
}

export async function syncBridges(
  db: Db,
  settlement: Partial<Record<ChainId, JsonRpc>>,
  origins: Map<number, JsonRpc>,
  options: { follow: boolean },
): Promise<void> {
  if (Number(getSync(db, PAYERS_KEY) ?? 1) < PAYERS_VERSION) {
    transaction(db, () => {
      db.exec(
        'update bridge_in set funder_checked = 0 where fill_tx is not null',
      )
      db.exec('delete from bridge_payer')
      setSync(db, PAYERS_KEY, String(PAYERS_VERSION))
      setSync(db, FUNDING_DONE_KEY, '0')
    })
    log('bridges', { payers: 'looked up again', version: PAYERS_VERSION })
  }
  let derived = 0
  for (;;) {
    let done = 0
    try {
      for (const [chain, rpc] of Object.entries(settlement)) {
        done += await matchFills(db, chain as ChainId, rpc)
        done += await findDirectFunders(db, chain as ChainId, rpc)
      }
      done += await findFunders(db, origins)
    } catch (e) {
      if (!options.follow) throw e
      log('bridges failed', { error: String(e) })
      await sleep(POLL_MS)
      continue
    }
    const complete = done === 0 && pending(db, origins) === 0
    if (complete && getSync(db, FUNDING_DONE_KEY) !== '1') {
      setSync(db, FUNDING_DONE_KEY, '1')
      derived = 0
    }
    if ((done > 0 || complete) && Date.now() - derived > IDENTITY_MS) {
      deriveIdentities(db)
      derived = Date.now()
    }
    if (done > 0) continue
    if (!options.follow) break
    await sleep(POLL_MS)
  }
}

/** Deposits whose funding is still to be looked up */
function pending(db: Db, origins: Map<number, JsonRpc>): number {
  const chains = [...origins.keys()]
  const bridged = chains.length
    ? (one<{ n: number }>(
        db,
        `select count(*) as n from bridge_in where fill_tx is not null
         and funder_checked = 0
         and origin_chain in (${chains.map(() => '?').join(', ')})`,
        ...chains,
      )?.n ?? 0)
    : 0
  const direct =
    one<{ n: number }>(
      db,
      'select count(*) as n from bridge_in where fill_tx is null and direct_checked = 0',
    )?.n ?? 0
  return bridged + direct
}

/** Step 1 for one batch of unchecked deposits; returns how many it checked */
export async function matchFills(
  db: Db,
  chain: ChainId,
  rpc: JsonRpc,
): Promise<number> {
  const deposits = all<DepositRow>(
    db,
    `select d.* from deposit d
     left join bridge_in b on b.chain = d.chain and b.mint_hash = d.mint_hash
     where d.chain = ? and b.mint_hash is null
     order by d.block desc limit ?`,
    chain,
    BATCH,
  )
  if (deposits.length === 0) return 0
  const window = WINDOW_BLOCKS[chain]
  const depositors = [...new Set(deposits.map((d) => d.depositor))]
  const incoming = await rpc.getLogs({
    address: CHAINS[chain].usdc,
    topics: [TOPICS.Transfer, null, depositors.map(pad)],
    fromBlock: Math.min(...deposits.map((d) => d.block)) - window,
    toBlock: Math.max(...deposits.map((d) => d.block)),
  })
  const funding = new Map<string, Log>()
  for (const d of deposits) {
    const last = incoming
      .filter(
        (l) =>
          topicAddress(l.topics[2]) === d.depositor &&
          l.transactionHash !== d.tx &&
          l.blockNumber >= d.block - window &&
          (l.blockNumber < d.block ||
            (l.blockNumber === d.block && l.logIndex < d.log_index)),
      )
      .at(-1)
    if (last) funding.set(d.mint_hash, last)
  }
  const receipts = await rpc.getReceiptLogs([
    ...new Set([...funding.values()].map((l) => l.transactionHash)),
  ])
  const insert = db.prepare(
    `insert into bridge_in (chain, mint_hash, fill_tx, origin_chain,
       deposit_id, origin_depositor)
     values (?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  let bridged = 0
  transaction(db, () => {
    for (const d of deposits) {
      const f = funding.get(d.mint_hash)
      const fill = f && fillTo(receipts.get(f.transactionHash) ?? [], chain, d)
      if (fill) bridged++
      insert.run(
        chain,
        d.mint_hash,
        fill ? (f?.transactionHash ?? null) : null,
        fill?.originChain ?? null,
        fill?.depositId ?? null,
        fill?.depositor ?? null,
      )
    }
  })
  log(`${chain} bridges`, {
    checked: deposits.length,
    bridged,
    down_to: deposits.at(-1)?.block,
  })
  return deposits.length
}

/** The Across fill in a transaction that paid a deposit's amount to its depositor */
function fillTo(
  logs: ReceiptLog[],
  chain: ChainId,
  d: DepositRow,
): { originChain: number; depositId: string; depositor: string } | undefined {
  for (const l of logs) {
    if (l.address.toLowerCase() !== ACROSS.spokePools[chain]) continue
    if (l.topics[0] !== ACROSS.FilledRelay) continue
    const w = (i: number) => l.data.slice(2 + 64 * i, 2 + 64 * (i + 1))
    // relayExecutionInfo: the recipient and amount as actually filled
    const recipient = `0x${w(11).slice(24)}`
    const amount = BigInt(`0x${w(13)}`)
    if (recipient !== d.depositor || amount !== BigInt(d.amount)) continue
    return {
      originChain: Number(BigInt(l.topics[1] ?? '0x0')),
      depositId: BigInt(l.topics[2] ?? '0x0').toString(),
      depositor: `0x${w(8).slice(24)}`,
    }
  }
  return undefined
}

/** Step 2 for bridged deposits whose origin chain has an RPC */
export async function findFunders(
  db: Db,
  origins: Map<number, JsonRpc>,
): Promise<number> {
  const chains = [...origins.keys()]
  if (chains.length === 0) return 0
  const rows = all<BridgeRow & { time: number }>(
    db,
    `select b.*, d.time from bridge_in b
     join deposit d on d.chain = b.chain and d.mint_hash = b.mint_hash
     where b.fill_tx is not null and b.funder_checked = 0
       and b.origin_chain in (${chains.map(() => '?').join(', ')})
     order by d.block desc limit ?`,
    ...chains,
    FUNDERS_PER_ROUND,
  )
  const update = db.prepare(
    `update bridge_in set origin_tx = ?, origin_time = ?, origin_token = ?,
       origin_amount = ?, funder = ?, funder_tx = ?, funder_amount = ?,
       funder_time = ?, funder_checked = 1
     where chain = ? and mint_hash = ?`,
  )
  const clear = db.prepare(
    'delete from bridge_payer where chain = ? and mint_hash = ?',
  )
  const insert = db.prepare(
    `insert into bridge_payer (chain, mint_hash, payer, tx, amount, time, kind)
     values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  // the chains in parallel, each chain's rows in order (newest first, so
  // that the block clock mostly searches near points it already knows)
  const results = await Promise.all(
    chains.map(async (id) => {
      const rpc = origins.get(id)
      if (!rpc) return []
      const done: [BridgeRow, Funding | undefined][] = []
      for (const row of rows.filter((r) => r.origin_chain === id)) {
        try {
          done.push([row, await funding(rpc, id, row)])
        } catch (e) {
          // an RPC that cannot answer is tried again next round
          log('bridge funder failed', { chain: id, error: String(e) })
        }
      }
      return done
    }),
  )
  let found = 0
  let checked = 0
  transaction(db, () => {
    for (const [row, r] of results.flat()) {
      checked++
      // the latest payment stands for the others where one is shown
      const latest = r?.payers.at(-1)
      if (latest) found++
      update.run(
        r?.originTx ?? null,
        r?.originTime ?? null,
        r?.token ?? null,
        r?.amount ?? null,
        latest?.payer ?? null,
        latest?.tx ?? null,
        latest?.amount ?? null,
        latest?.time ?? null,
        row.chain,
        row.mint_hash,
      )
      clear.run(row.chain, row.mint_hash)
      for (const p of r?.payers ?? []) {
        insert.run(
          row.chain,
          row.mint_hash,
          p.payer,
          p.tx,
          p.amount,
          p.time,
          p.kind,
        )
      }
    }
  })
  if (rows.length > 0) log('bridge funders', { checked, found })
  return checked
}

interface Payer {
  payer: string
  tx: string
  amount: string
  time: number
  kind: CodeKind
}

interface Funding {
  originTx: string
  originTime: number
  token?: string
  amount?: string
  payers: Payer[]
}

async function funding(
  rpc: JsonRpc,
  chainId: number,
  row: BridgeRow & { time: number },
): Promise<Funding | undefined> {
  const origin = ORIGIN_CHAINS[chainId]
  const depositor = row.origin_depositor ?? ''
  if (!origin || !row.deposit_id) return undefined
  const clock = clockOf(rpc)
  const fromBlock = (await clock.bracket(row.time - BRIDGE_WINDOW_SECONDS))[0]
  const toBlock = (await clock.bracket(row.time + 60))[1]
  const [deposit] = await rpc.getLogs({
    address: origin.spokePool,
    topics: [
      ACROSS.FundsDeposited,
      pad(CHAIN_IDS[row.chain]),
      pad(BigInt(row.deposit_id)),
      pad(depositor),
    ],
    fromBlock,
    toBlock,
  })
  if (!deposit) return undefined
  // what the origin depositor paid in the deposit's transaction
  const logs = (await rpc.getReceiptLogs([deposit.transactionHash])).get(
    deposit.transactionHash,
  )
  const paid = logs?.find(
    (l) =>
      l.topics[0] === TOPICS.Transfer &&
      topicAddress(l.topics[1]) === depositor,
  )
  const times = await rpc.getBlockTimestamps([deposit.blockNumber])
  const base: Funding = {
    originTx: deposit.transactionHash,
    originTime: times.get(deposit.blockNumber) ?? 0,
    payers: [],
  }
  if (!paid) return base
  const token = paid.address.toLowerCase()
  const result = { ...base, token, amount: BigInt(paid.data).toString() }
  // payments in since the previous transfer out, before this one
  const since = (
    await clock.bracket(result.originTime - PAYER_LOOKBACK_SECONDS)
  )[0]
  const before = (l: Log) =>
    l.transactionHash !== deposit.transactionHash &&
    (l.blockNumber < deposit.blockNumber ||
      (l.blockNumber === deposit.blockNumber &&
        l.logIndex < Number(paid.logIndex)))
  const [into, out] = await Promise.all([
    rpc.getLogs({
      address: token,
      topics: [TOPICS.Transfer, null, pad(depositor)],
      fromBlock: since,
      toBlock: deposit.blockNumber,
    }),
    rpc.getLogs({
      address: token,
      topics: [TOPICS.Transfer, pad(depositor), null],
      fromBlock: since,
      toBlock: deposit.blockNumber,
    }),
  ])
  const last = out.filter(before).at(-1)
  const after = (l: Log) =>
    !last ||
    l.blockNumber > last.blockNumber ||
    (l.blockNumber === last.blockNumber && l.logIndex > last.logIndex)
  const payments = into.filter((l) => before(l) && after(l))
  if (payments.length === 0) return result
  const [stamps, codes] = await Promise.all([
    rpc.getBlockTimestamps([...new Set(payments.map((l) => l.blockNumber))]),
    rpc.getCodes([...new Set(payments.map((l) => topicAddress(l.topics[1])))]),
  ])
  return {
    ...result,
    payers: payments.map((l) => {
      const payer = topicAddress(l.topics[1])
      return {
        payer,
        tx: l.transactionHash,
        amount: BigInt(l.data).toString(),
        time: stamps.get(l.blockNumber) ?? 0,
        kind: codeKind(codes.get(payer)),
      }
    }),
  }
}

export type CodeKind = 'eoa' | 'delegated' | 'contract'

/** An EOA has no code, an EIP-7702 account delegates with 0xef0100 */
function codeKind(code: string | undefined): CodeKind {
  if (!code || code === '0x') return 'eoa'
  return code.startsWith('0xef0100') ? 'delegated' : 'contract'
}

/**
 * For deposits that did not come through a bridge: the last USDC transfer
 * into the deposit address before the deposit, its sender's code, and the
 * sender of its transaction (who swapped, when a router paid)
 */
export async function findDirectFunders(
  db: Db,
  chain: ChainId,
  rpc: JsonRpc,
): Promise<number> {
  const deposits = all<DepositRow>(
    db,
    `select d.* from deposit d
     join bridge_in b on b.chain = d.chain and b.mint_hash = d.mint_hash
     where d.chain = ? and b.fill_tx is null and b.direct_checked = 0
     order by d.block desc limit ?`,
    chain,
    BATCH,
  )
  if (deposits.length === 0) return 0
  const window = WINDOW_BLOCKS[chain]
  const incoming = await rpc.getLogs({
    address: CHAINS[chain].usdc,
    topics: [
      TOPICS.Transfer,
      null,
      [...new Set(deposits.map((d) => pad(d.depositor)))],
    ],
    fromBlock: Math.min(...deposits.map((d) => d.block)) - window,
    toBlock: Math.max(...deposits.map((d) => d.block)),
  })
  const funding = new Map<string, Log>()
  for (const d of deposits) {
    const last = incoming
      .filter(
        (l) =>
          topicAddress(l.topics[2]) === d.depositor &&
          l.transactionHash !== d.tx &&
          l.blockNumber >= d.block - window &&
          (l.blockNumber < d.block ||
            (l.blockNumber === d.block && l.logIndex < d.log_index)),
      )
      .at(-1)
    if (last) funding.set(d.mint_hash, last)
  }
  const found = [...funding.values()]
  const [codes, senders] = await Promise.all([
    rpc.getCodes([...new Set(found.map((l) => topicAddress(l.topics[1])))]),
    rpc.getTxSenders([...new Set(found.map((l) => l.transactionHash))]),
  ])
  const update = db.prepare(
    `update bridge_in set fund_from = ?, fund_kind = ?, fund_tx = ?,
       fund_sender = ?, fund_amount = ?, direct_checked = 1
     where chain = ? and mint_hash = ?`,
  )
  transaction(db, () => {
    for (const d of deposits) {
      const f = funding.get(d.mint_hash)
      const from = f && topicAddress(f.topics[1])
      update.run(
        from ?? null,
        from ? codeKind(codes.get(from)) : null,
        f?.transactionHash ?? null,
        f ? (senders.get(f.transactionHash) ?? null) : null,
        f ? BigInt(f.data).toString() : null,
        chain,
        d.mint_hash,
      )
    }
  })
  log(`${chain} direct funders`, {
    checked: deposits.length,
    found: funding.size,
    down_to: deposits.at(-1)?.block,
  })
  return deposits.length
}

/** EVM chain ids of the settlement chains, the destinations of the fills */
const CHAIN_IDS: Record<ChainId, bigint> = { ethereum: 1n, polygon: 137n }

/** One clock per RPC, so known points carry over from round to round */
const clocks = new WeakMap<JsonRpc, BlockClock>()

function clockOf(rpc: JsonRpc): BlockClock {
  let clock = clocks.get(rpc)
  if (!clock) {
    clock = new BlockClock(rpc)
    clocks.set(rpc, clock)
  }
  return clock
}

/**
 * Block numbers by time on a chain whose blocks come at an irregular pace:
 * a search between known (block, time) points, interpolating and falling
 * back to halving. Brackets are good to BRACKET blocks.
 */
const BRACKET = 64

class BlockClock {
  /** known points, by block */
  private points = new Map<number, number>()
  private head: Promise<number> | undefined

  constructor(private readonly rpc: JsonRpc) {}

  private async time(block: number): Promise<number> {
    const known = this.points.get(block)
    if (known !== undefined) return known
    const t = (await this.rpc.getBlockTimestamps([block])).get(block) ?? 0
    this.points.set(block, t)
    return t
  }

  /** Blocks [lo, hi] with time(lo) <= `time` < time(hi), or the head */
  async bracket(time: number): Promise<[number, number]> {
    this.head ??= this.rpc.getBlockNumber()
    const head = await this.head
    let lo = 1
    let hi = head
    for (const [b, t] of this.points) {
      if (t <= time && b > lo) lo = b
      if (t > time && b < hi) hi = b
    }
    let loT = await this.time(lo)
    let hiT = await this.time(hi)
    if (time >= hiT) return [hi, hi]
    for (let step = 0; hi - lo > BRACKET && step < 64; step++) {
      const guess =
        step % 3 === 2 || hiT <= loT
          ? Math.floor((lo + hi) / 2)
          : Math.round(lo + ((time - loT) * (hi - lo)) / (hiT - loT))
      const b = Math.min(hi - 1, Math.max(lo + 1, guess))
      const t = await this.time(b)
      if (t <= time) {
        lo = b
        loT = t
      } else {
        hi = b
        hiT = t
      }
    }
    return [lo, hi]
  }
}

/** An address or number as a 32-byte topic */
function pad(value: string | bigint): string {
  const hex =
    typeof value === 'bigint'
      ? value.toString(16)
      : value.slice(2).toLowerCase()
  return `0x${hex.padStart(64, '0')}`
}

function topicAddress(topic: string | undefined): string {
  return `0x${(topic ?? '').slice(-40).toLowerCase()}`
}
