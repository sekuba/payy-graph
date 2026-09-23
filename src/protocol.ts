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
 * On 2025-09-12 the treasury deposited 2.3M USDC (22:02 and 22:15 UTC) and a
 * hub wallet then paid out 960 notes in two hours: the balances of the
 * previous Payy chain, re-issued on this one. Every wallet that existed
 * before then has its history start in this window, and what happened on the
 * old chain is not visible here.
 */
export const MIGRATION_DISTRIBUTION = {
  start: Date.UTC(2025, 8, 12, 22, 0) / 1000,
  end: Date.UTC(2025, 8, 13, 0, 0) / 1000,
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

export const TREASURY_LABEL = 'Payy treasury'

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
  '0x69ca5dec143b02499f83bb34b22a122a70e117ca': 'Payy card settlement',
  '0x7b21b3e4382bf10b011637ba20b16f77fe53f6b8': 'Payy card settlement',
}

export function labelOf(address: string): string | undefined {
  return KNOWN_ADDRESSES[address.toLowerCase()]
}
