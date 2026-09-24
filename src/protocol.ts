/**
 * Facts about the Payy protocol that this indexer relies on. Every value here
 * was verified against onchain state or the Payy repository
 * (github.com/polybase/payy, commit 2f95947).
 *
 * Payy is a UTXO-style ZK rollup. The chain state is a sparse Merkle tree of
 * note commitments. Every transaction is a `utxo` Noir proof whose public
 * inputs are published by the node (`noir/utxo/src/main.nr`):
 *
 *   commitments[0..1]  the two notes consumed (zero = padding)
 *   commitments[2..3]  the two notes created  (zero = padding)
 *   messages[0]        kind: 1 send, 2 mint (deposit), 3 burn (withdrawal)
 *   messages[1]        note kind (token id)
 *   messages[2]        mint or burn amount, zero for sends
 *   messages[3]        mint hash (matches MintAdded on L1) or burn hash,
 *                      which is defined as commitments[0]
 *   messages[4]        burn: L1 recipient address
 *
 * There are no nullifiers: a spend names the commitment it consumes, so the
 * edge "output of tx A is input of tx B" is public. Only the note contents
 * (owner, value, entropy) are hidden.
 */

import { PUBLIC_LABELS } from './labels.generated'

export const PAYY_NODE_URL = 'https://validators.mainnet.payy.network/v0'
export const PAYY_EXPLORER_URL = 'https://payy.network/explorer'

export const ZERO_COMMITMENT = '0'.repeat(64)

/**
 * The only note kind in use. It encodes chain id 137 and the Polygon USDC
 * address, and is mapped to native USDC on both settlement chains, which is
 * how the Polygon-era notes stayed spendable after the move to Ethereum.
 */
export const NOTE_KIND_USDC =
  '000200000000000000893c499c542cef5e3811e1192ce70d8cc03d5c33590000'

export const USDC_DECIMALS = 6

export enum TxKind {
  Send = 1,
  Mint = 2,
  Burn = 3,
}

export type ChainId = 'ethereum' | 'polygon'

export interface ChainInfo {
  id: ChainId
  name: string
  /** RollupV1 proxy that settles Payy state and escrows USDC */
  rollup: string
  usdc: string
  /** Block of the Rollup deployment, where indexing starts */
  fromBlock: number
  /** Blocks to stay behind the head, to avoid reorgs */
  confirmations: number
  explorer: string
  /** Environment variable holding the RPC url */
  rpcEnv: string
}

/**
 * The current Payy chain started on 2025-08-28 settling on Polygon and moved
 * to Ethereum on 2026-02-17 at height 14325150. The Polygon contract's final
 * root was installed on Ethereum via setRoot(), heights continue and the note
 * kind is unchanged, so this is one continuous history with two L1 sides.
 */
export const CHAINS: Record<ChainId, ChainInfo> = {
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    rollup: '0xcd92281548df923141fd9b690c7c8522e12e76e6',
    usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    fromBlock: 75774389,
    confirmations: 128,
    explorer: 'https://polygonscan.com',
    rpcEnv: 'POLYGON_RPC_URL',
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    rollup: '0x367c1eaf14aa06b78ce76bd0243297de79d85270',
    usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    fromBlock: 24475975,
    confirmations: 12,
    explorer: 'https://etherscan.io',
    rpcEnv: 'ETHEREUM_RPC_URL',
  },
}

/**
 * On 2025-09-12 the balances of the previous Payy chain were re-issued on
 * this one. Starting with a treasury deposit at 21:58 UTC, a Payy wallet
 * paid out notes in chains of sends (one every few seconds, output 0 to a
 * wallet, output 1 the change), topped up by further treasury deposits of
 * 2.39M USDC in total. It paid out about 2,800 notes, most of them by 03:00
 * UTC the next morning. Every wallet that existed before then has its
 * history start in this distribution; which old wallet received which note
 * was decided off-chain, so what happened on the old chain is not visible
 * here. The payout transactions are identified in `src/graph/roles.ts`.
 */
export const MIGRATION_DISTRIBUTION = {
  /** the first treasury deposit, 10,000 USDC at height 1291001 */
  root: '2bb973ebee4b04a101ba015595e2fbd432083017614dd90886a357532cb5722a',
  start: Date.UTC(2025, 8, 12, 21, 55) / 1000,
  end: Date.UTC(2025, 8, 13, 12, 0) / 1000,
}

/** Event topics of RollupV1 and ERC-20 (keccak256 of the signature) */
export const TOPICS = {
  /** MintAdded(bytes32 indexed mint_hash, uint256 value, bytes32 note_kind) */
  MintAdded:
    '0xc4adcac6a89d730f3a6da5d846bba3d858a8fc5884e0f80940a3a3b96a4ae6f1',
  /** Burned(address indexed token, bytes32 indexed burn_hash, address indexed recipient, bool substitute, bool success) */
  Burned: '0x25bab1ec4b6635a8e0740834e52ce1aee362e9c38447738aa7b75b7e06275b07',
  /** RollupVerified(uint256 indexed height, bytes32 root) */
  RollupVerified:
    '0x401f796450733fd22827ddc018ca37051459a8035c4026f533c294797bb8a49e',
  /** Transfer(address indexed from, address indexed to, uint256 value) */
  Transfer:
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const

/**
 * Payy's published code, at the commit the facts above were checked
 * against, and the passages on whose keys spend a wallet's notes
 * (src/graph/keys.ts). Each is a path with the lines, for links.
 */
export const PAYY_REPO = 'https://github.com/polybase/payy'
export const PAYY_COMMIT = '2f95947f12981a838f6f0c9dddace825bf835502'
/** the FAQ answer "How does Payy work?" */
export const PAYY_FAQ_URL =
  'https://docs.payy.network/payy-wallet/payy-wallet-faq'
export const PAYY_CODE = {
  /** the app derives a note's key from the wallet key and the note's psi, or uses an explicit one */
  derivedKey: 'pkg/wallet-data-dep/src/note.rs#L111-L137',
  /** keccak(psi ‖ wallet key) */
  deriveFn: 'pkg/wallet-primitives/src/lib.rs#L7-L19',
  /** the kinds of key a note in the app can have: PROVIDED, WALLET, DERIVED */
  keyKinds:
    'app/packages/payy/src/ts-rs-bindings/WalletPrivateKeyKind.ts#L7-L12',
  /** the server's notes table: private_key and owner_id */
  notesTable: 'pkg/database/src/schema.rs#L88-L110',
  /** "Owner ID of the note (as all private keys are ephemeral)" */
  ownerId: 'pkg/guild-interface/src/notes/note.rs#L33-L34',
  /** the server picks notes of an owner and spends them */
  assign: 'pkg/notes-interface/src/assign.rs#L33-L45',
  /** "Generate a UTXO proof, submit the transaction" */
  transfer: 'pkg/notes-interface/src/transfer.rs#L8-L11',
  /** the migration request: every old note with its private key */
  migrateRequest: 'pkg/guild-interface/src/migrate.rs#L16-L27',
  /** POST /migrate/notes */
  migrateClient: 'pkg/guild-client-http/src/migrate.rs#L11-L22',
  /** the response: notes with private keys */
  migrateResponse: 'pkg/guild-interface/src/migrate.rs#L13-L14',
  /** a new note gets a random private key */
  randomKey: 'pkg/notes-interface/src/data.rs#L36-L42',
  /** a payment link carries the note's private key */
  linkKey: 'pkg/parse-link/src/note_url.rs#L45-L46',
  /** POST /notes: the app registers a note with the server, private key included */
  createNote: 'pkg/guild-interface/src/notes/create.rs#L34-L46',
  /** a ramp deposit is delivered as a private key */
  rampKey: 'pkg/ramps-interface/src/transaction/kinds/deposit.rs#L14-L19',
  /** a claim: the app spends a received note (link, receive) to a key of its own */
  claim: 'pkg/wallet-data-dep/src/kinds/claim.rs#L37-L54',
} as const

export function payyCodeUrl(ref: string): string {
  return `${PAYY_REPO}/blob/${PAYY_COMMIT}/${ref}`
}

export const TREASURY_LABEL = 'Payy treasury'
export const CARD_LABEL = 'Payy card settlement'
export const EXPLOITER_LABEL = 'Payy exploiter 2026-09-24'

/**
 * Addresses operated by Payy or its service providers, as observed onchain.
 * Labels are shown next to the address, nothing is hidden.
 */
export const KNOWN_ADDRESSES: Record<string, string> = {
  // Funds the fronted withdrawals (substituteBurn) and receives the refund
  // when the original burn is settled; present on both chains.
  '0x7c7e3fd85854be2d95516eda97a808424e717978': 'Payy burn substitutor',
  // Relays mintWithAuthorization() deposits on behalf of users.
  '0x68d9fd8dcf96b43327db1c4ecdbccd3c79d9c51c': 'Payy deposit relayer',
  '0x3d9dfb012b72cc35f2a1717b2a08a4cf978f8b50': 'Payy deposit relayer',
  // Deployer key from the Payy repository README (eth/README.md).
  '0x6b96f1a8d65ede8ad688716078b3dd79f9bd7323': 'Payy deployer',
  '0x230dfb03f078b0d5e705f4624fcc915f3126b40f': 'PayyMultisig',
  // Deposited 2.4M USDC on Polygon in 2025; funded onchain by the
  // PayyMultisig and by 0x9417d1…, the address that received Payy's first
  // test withdrawals. Their notes seed the pools Payy pays users from.
  '0x710dc565abdc3c0804c76d2978754c6e5d1e3330': TREASURY_LABEL,
  '0xbff07f212bbf60143d7672490ee901b8df34eb9d': TREASURY_LABEL,
  '0x9417d18483c75155dcf2690ea85166f13beff852': TREASURY_LABEL,
  '0x5343b904bf837befb2f5a256b0cd5fbf30503d38': 'Payy prover',
  // Forwarder contracts that receive the notes users spend with the Payy
  // card, merged by a collector wallet and withdrawn in batches: 8k
  // withdrawals and 27M USDC by 2026-09, each swept to a single address.
  '0x69ca5dec143b02499f83bb34b22a122a70e117ca': CARD_LABEL,
  '0x7b21b3e4382bf10b011637ba20b16f77fe53f6b8': CARD_LABEL,
  // Received the three withdrawals of 2026-09-24 whose proofs named no
  // input note (burn hash zero), 1.92M USDC in all, after a 5 USDC test
  // withdrawal two days earlier.
  '0xaa4985dbdabfaca344237d40f7e06c4a0bb57e70': EXPLOITER_LABEL,
}

/** Burn recipients of the card collector: Polygon until 2026-02-17, then Ethereum */
export const CARD_SETTLEMENT = Object.keys(KNOWN_ADDRESSES).filter(
  (a) => KNOWN_ADDRESSES[a] === CARD_LABEL,
)

/** Operated by Payy (above), else a public label (src/labels.ts) */
export function labelOf(address: string): string | undefined {
  const a = address.toLowerCase()
  return KNOWN_ADDRESSES[a] ?? PUBLIC_LABELS[a]?.label
}

/** Where a label comes from, for display next to it */
export function labelSource(address: string): string | undefined {
  const a = address.toLowerCase()
  if (KNOWN_ADDRESSES[a]) return 'Payy, as observed onchain (src/protocol.ts)'
  return PUBLIC_LABELS[a]?.source
}

/**
 * Cross-chain deposits. The Payy app deposits USDC held on other chains
 * through Across: the user pays a fresh address on that chain, which
 * deposits into Across; a relayer fills the same amount minus fees to a
 * fresh address on the settlement chain, which deposits it into Payy with an
 * EIP-3009 authorization seconds later. The fill names the origin chain and
 * the origin depositor, so the deposit is traced back across the bridge
 * (src/l1/bridges.ts). Verified with a deposit from Base on 2026-09-23:
 * Base 0x5a0cf28c…, Across deposit 6239727, fill 0xfe4ba410…, Payy deposit
 * 0x2c0ba73d….
 */
export const ACROSS = {
  /** SpokePool proxies that fill relays on the settlement chains */
  spokePools: {
    ethereum: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
    polygon: '0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096',
  } as Record<ChainId, string>,
  /**
   * FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount,
   * uint256 outputAmount, uint256 repaymentChainId, uint256 indexed
   * originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32
   * exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer,
   * bytes32 depositor, bytes32 recipient, bytes32 messageHash,
   * (bytes32 updatedRecipient, bytes32 updatedMessageHash,
   * uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)
   */
  FilledRelay:
    '0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208',
  /**
   * FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256
   * inputAmount, uint256 outputAmount, uint256 indexed destinationChainId,
   * uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline,
   * uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient,
   * bytes32 exclusiveRelayer, bytes message), on the origin chain
   */
  FundsDeposited:
    '0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3',
}

/**
 * A chain deposits are bridged from, by EVM chain id. Users often pay in
 * USDT, which Across's periphery swaps to USDC before depositing.
 */
export interface OriginChain {
  name: string
  explorer: string
  /** Environment variable holding the RPC url */
  rpcEnv: string
  /** Across SpokePool there */
  spokePool: string
  /** the tokens whose amounts are shown, by address */
  tokens: Record<string, { symbol: string; decimals: number }>
}

export const ORIGIN_CHAINS: Record<number, OriginChain> = {
  1: {
    name: 'Ethereum',
    explorer: 'https://etherscan.io',
    rpcEnv: 'ETHEREUM_RPC_URL',
    spokePool: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
    tokens: {
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': usd('USDC'),
      '0xdac17f958d2ee523a2206206994597c13d831ec7': usd('USDT'),
    },
  },
  10: {
    name: 'Optimism',
    explorer: 'https://optimistic.etherscan.io',
    rpcEnv: 'OPTIMISM_RPC_URL',
    spokePool: '0x6f26bf09b1c792e3228e5467807a900a503c0281',
    tokens: {
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85': usd('USDC'),
      '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': usd('USDT'),
      '0x01bff41798a0bcf287b996046ca68b395dbc1071': usd('USDT0'),
    },
  },
  56: {
    name: 'BNB Chain',
    explorer: 'https://bscscan.com',
    rpcEnv: 'BSC_RPC_URL',
    spokePool: '0x4e8e101924ede233c13e2d8622dc8aed2872d505',
    tokens: {
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': usd('USDC', 18),
      '0x55d398326f99059ff775485246999027b3197955': usd('USDT', 18),
    },
  },
  137: {
    name: 'Polygon',
    explorer: 'https://polygonscan.com',
    rpcEnv: 'POLYGON_RPC_URL',
    spokePool: '0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096',
    tokens: {
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': usd('USDC'),
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': usd('USDT0'),
    },
  },
  8453: {
    name: 'Base',
    explorer: 'https://basescan.org',
    rpcEnv: 'BASE_RPC_URL',
    spokePool: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64',
    tokens: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': usd('USDC') },
  },
  42161: {
    name: 'Arbitrum',
    explorer: 'https://arbiscan.io',
    rpcEnv: 'ARBITRUM_RPC_URL',
    spokePool: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a',
    tokens: {
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': usd('USDC'),
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': usd('USDT0'),
    },
  },
}

function usd(symbol: string, decimals = 6) {
  return { symbol, decimals }
}
