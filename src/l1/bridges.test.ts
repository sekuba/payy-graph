import { expect } from 'earl'
import { openDb } from '../db'
import { identityEdges } from '../graph/identity'
import { addressSummary, bridgeOf } from '../graph/queries'
import { insertTxns } from '../payy/indexer'
import { ACROSS, CHAINS, ORIGIN_CHAINS, TOPICS } from '../protocol'
import { findFunders, matchFills } from './bridges'
import type { JsonRpc, Log, LogFilter, ReceiptLog } from './rpc'

/**
 * The deposit from Base of 2026-09-23: donnoh.eth pays 3 USDC to a fresh
 * address on Base, which bridges it with Across; the fill pays 2.892723 to a
 * fresh address on Ethereum, which deposits it into Payy.
 */
const USER = '0x33d66941465ac776c38096cb1bc496c673ae7390'
const BASE_ADDRESS = '0xc3c083e20f326b57d12fb3a2e199f23030325bc9'
const ETH_ADDRESS = '0x82395518d9a9320b816c876bd390c3ae5ce30b46'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const SPOKE_PERIPHERY = '0x50cfe7c1938db66a1a6d2e86d36f39fbef3d5c4a'

const word = (v: bigint | string) =>
  (typeof v === 'string' ? v.slice(2) : v.toString(16)).padStart(64, '0')
const topic = (v: bigint | string) => `0x${word(v)}`

function transfer(
  from: string,
  to: string,
  value: bigint,
  block: number,
  tx: string,
  logIndex = 0,
): Log {
  return {
    topics: [TOPICS.Transfer, topic(from), topic(to)],
    data: topic(value),
    blockNumber: block,
    transactionHash: tx,
    logIndex,
  }
}

function history() {
  const db = openDb(':memory:')
  insertTxns(db, [])
  db.prepare(
    `insert into deposit (chain, mint_hash, block, tx, log_index, time, depositor, amount)
     values ('ethereum', 'mh', 100, '0xdeposit', 5, 1000, ?, 2892723)`,
  ).run(ETH_ADDRESS)
  return db
}

/** A settlement-chain RPC that knows the fill */
const ethereum = {
  getLogs: async (f: LogFilter) =>
    f.address === CHAINS.ethereum.usdc
      ? [transfer('0xfd03', ETH_ADDRESS, 2_892_723n, 99, '0xfill')]
      : [],
  getReceiptLogs: async (txs: string[]) =>
    new Map<string, ReceiptLog[]>(
      txs.map((t) => [
        t,
        t === '0xfill'
          ? [
              {
                address: ACROSS.spokePools.ethereum,
                topics: [ACROSS.FilledRelay, topic(8453n), topic(6239727n)],
                data: `0x${[
                  word(BASE_USDC),
                  word(CHAINS.ethereum.usdc),
                  word(3_000_000n),
                  word(2_892_723n),
                  word(8453n),
                  word(0n),
                  word(0n),
                  word(0n),
                  word(BASE_ADDRESS),
                  word(ETH_ADDRESS),
                  word(0n),
                  word(ETH_ADDRESS),
                  word(0n),
                  word(2_892_723n),
                  word(0n),
                ].join('')}`,
                logIndex: '0x0',
              },
            ]
          : [],
      ]),
    ),
} as unknown as JsonRpc

/** Base at one block per second, block 1 at time 1 */
const base = {
  getBlockNumber: async () => 2000,
  getCodes: async (addresses: string[]) =>
    new Map(addresses.map((a) => [a, '0x'])),
  getBlockTimestamps: async (blocks: number[]) =>
    new Map(blocks.map((b) => [b, b])),
  getLogs: async (f: LogFilter) => {
    const logs: (Log & { address: string })[] = [
      // an earlier payment, then the one that is bridged
      {
        ...transfer(USER, BASE_ADDRESS, 1_000_000n, 200, '0xold'),
        address: BASE_USDC,
      },
      // the previous bridge: what came in before it is not this one's
      {
        ...transfer(
          BASE_ADDRESS,
          SPOKE_PERIPHERY,
          1_000_000n,
          500,
          '0xearlier',
        ),
        address: BASE_USDC,
      },
      {
        ...transfer(USER, BASE_ADDRESS, 3_000_000n, 950, '0xpay'),
        address: BASE_USDC,
      },
      {
        address: ORIGIN_CHAINS[8453]?.spokePool ?? '',
        topics: [
          ACROSS.FundsDeposited,
          topic(1n),
          topic(6239727n),
          topic(BASE_ADDRESS),
        ],
        data: '0x',
        blockNumber: 962,
        transactionHash: '0xbridge',
        logIndex: 4,
      },
    ]
    return logs.filter(
      (l) =>
        l.address === f.address &&
        l.blockNumber >= f.fromBlock &&
        l.blockNumber <= f.toBlock &&
        f.topics.every((t, i) => t === null || t === l.topics[i]),
    )
  },
  getReceiptLogs: async (txs: string[]) =>
    new Map<string, ReceiptLog[]>(
      txs.map((t) => [
        t,
        t === '0xbridge'
          ? [
              {
                ...transfer(BASE_ADDRESS, SPOKE_PERIPHERY, 3_000_000n, 962, t),
                address: BASE_USDC,
                logIndex: '0x2',
              },
            ]
          : [],
      ]),
    ),
} as unknown as JsonRpc

describe(matchFills.name, () => {
  it('traces a deposit to its Across fill and on to who paid for it', async () => {
    const db = history()
    expect(await matchFills(db, 'ethereum', ethereum)).toEqual(1)
    // checked once
    expect(await matchFills(db, 'ethereum', ethereum)).toEqual(0)
    expect(bridgeOf(db, 'ethereum', 'mh')?.depositor).toEqual(BASE_ADDRESS)

    expect(await findFunders(db, new Map([[8453, base]]))).toEqual(1)
    // only the payment since the previous transfer out
    expect(
      db
        .prepare('select payer, tx, kind from bridge_payer')
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([{ payer: USER, tx: '0xpay', kind: 'eoa' }])
    expect(bridgeOf(db, 'ethereum', 'mh')).toEqual({
      via: 'Across',
      chain: 8453,
      depositor: BASE_ADDRESS,
      fillTx: '0xfill',
      originTx: '0xbridge',
      originTime: 962,
      funder: {
        address: USER,
        tx: '0xpay',
        time: 950,
        amount: 3_000_000,
        symbol: 'USDC',
      },
    })
  })

  it('leaves a deposit whose funds did not come from a fill of its amount', async () => {
    const db = history()
    db.prepare('update deposit set amount = 2000000').run()
    await matchFills(db, 'ethereum', ethereum)
    expect(bridgeOf(db, 'ethereum', 'mh')).toEqual(undefined)
  })
})

describe(addressSummary.name, () => {
  it('lists the deposits an address paid for on another chain', async () => {
    const db = history()
    await matchFills(db, 'ethereum', ethereum)
    await findFunders(db, new Map([[8453, base]]))
    // the deposit's mint on Payy
    db.prepare(
      `insert into txn (hash, height, idx, time, kind, amount, msg_hash, burn_addr)
       values ('mint', 1, 0, 1000, 2, 2892723, 'mh', null)`,
    ).run()
    expect(addressSummary(db, USER).deposits.map((d) => d.txHash)).toEqual([
      'mint',
    ])
  })
})

describe(identityEdges.name, () => {
  it('leaves out payers that paid more than two addresses', () => {
    const db = history()
    const addDeposit = db.prepare(
      `insert into deposit (chain, mint_hash, block, tx, log_index, time, depositor, amount)
       values ('ethereum', ?, 100, ?, 0, 1000, ?, 1)`,
    )
    const addFunding = db.prepare(
      `insert into bridge_in (chain, mint_hash, fund_from, fund_kind, fund_tx, fund_sender, direct_checked)
       values ('ethereum', ?, ?, ?, ?, ?, 1)`,
    )
    // an exchange pays three users; a user pays their own deposit address;
    // a router pays one, sent by the user who swapped
    for (const [i, from, kind, sender] of [
      [1, '0xexchange', 'eoa', '0xexchange'],
      [2, '0xexchange', 'eoa', '0xexchange'],
      [3, '0xexchange', 'eoa', '0xexchange'],
      [4, '0xalice', 'eoa', '0xalice'],
      [5, '0xrouter', 'contract', '0xbob'],
    ] as const) {
      addDeposit.run(`m${i}`, `0xt${i}`, `0xd${i}`)
      addFunding.run(`m${i}`, from, kind, `0xf${i}`, sender)
    }
    const edges = identityEdges(db).map((e) => `${e.a}>${e.b}`)
    expect(edges).toEqual(['0xalice>0xd4', '0xbob>0xd5'])
  })
})
