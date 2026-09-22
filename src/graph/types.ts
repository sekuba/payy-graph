/** Shared between the API and the web UI. Amounts are in micro USDC. */

export type ChainId = 'ethereum' | 'polygon'

export interface TxnNode {
  hash: string
  height: number
  time: number
  /** 1 send, 2 mint, 3 burn */
  kind: 1 | 2 | 3
  /** minted or burned amount */
  amount: number
}

export interface NoteEdge {
  commitment: string
  /** tx that created the note; missing if outside the loaded graph */
  from?: string
  /** tx that spent the note; missing if unspent or outside the graph */
  to?: string
  /** true when `to` exists but was not loaded (funds continue elsewhere) */
  continues?: boolean
  /** inferred value when the graph determines it */
  value?: number
  /** otherwise the bounds that follow from the known amounts */
  min: number
  max?: number
}

export interface Deposit {
  mintHash: string
  /** Payy tx that consumed the deposit */
  txHash: string
  chain: ChainId
  l1Tx: string
  time: number
  depositor: string
  label?: string
  amount: number
  /** transactions between this deposit and the focused transaction */
  hops?: number
}

export interface Withdrawal {
  burnHash: string
  /** Payy burn tx */
  txHash: string
  recipient: string
  label?: string
  amount: number
  time: number
  /** L1 side, missing while the burn is not yet settled */
  chain?: ChainId
  /** tx that paid the recipient (the fronting tx if substituted) */
  paidTx?: string
  /** tx that settled the burn onchain */
  settledTx?: string
  substituted: boolean
  /** transactions between the focused transaction and this withdrawal */
  hops?: number
}

/** Where a note that left the path ended up */
export type Destination =
  | {
      type: 'withdrawn'
      recipient: string
      label?: string
      chain?: ChainId
      time: number
      amount: number
    }
  /** merged by other wallets; the withdrawals those merges led to */
  | {
      type: 'collected'
      recipients: { address: string; label?: string; count: number }[]
    }
  | { type: 'circulating' }
  | { type: 'unspent' }

/** One step of a withdrawal's history, walking back along the notes */
export interface PathHop {
  txHash: string
  time: number
  height: number
  kind: 'withdrawal' | 'send' | 'deposit'
  /** withdrawn or deposited amount */
  amount?: number
  /** deposit hops: who deposited */
  depositor?: string
  /** withdrawal hops: who was paid */
  recipient?: string
  label?: string
  chain?: ChainId
  l1Tx?: string
  /** the note that left the path here (a payment, or a withdrawal's change) */
  out?: {
    commitment: string
    value?: number
    min: number
    max?: number
    destination: Destination
  }
}

export type PathOrigin =
  | { type: 'deposit'; amount: number; time: number; deposit?: Deposit }
  | {
      type: 'migration'
      time: number
      /** treasury deposits behind the distribution, from the closure */
      treasury: { amount: number; count: number }
    }
  | { type: 'merge'; time: number }
  | { type: 'limit' }

export interface Path {
  withdrawal: Withdrawal
  /** oldest first */
  hops: PathHop[]
  origin: PathOrigin
}

export interface Graph {
  txns: TxnNode[]
  notes: NoteEdge[]
  deposits: Deposit[]
  withdrawals: Withdrawal[]
  /** traversal stopped at the node limit */
  truncated: boolean
}

export interface AddressSummary {
  address: string
  label?: string
  withdrawals: Withdrawal[]
  deposits: Deposit[]
}

export interface Status {
  payyHeight?: number
  txns: number
  notes: number
  deposits: number
  withdrawals: number
  l1: Record<ChainId, { block: number } | undefined>
}
