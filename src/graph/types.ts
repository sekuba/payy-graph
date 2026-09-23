/** Shared between the API and the web UI. Amounts are in micro USDC. */

import type { ChainId, TxKind } from '../protocol'

export interface TxnNode {
  hash: string
  height: number
  time: number
  kind: TxKind
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
  /** paid out by the migration distribution, which is not expanded */
  source?: 'migration'
  /** paid into this card batch (its burn tx), which is not expanded */
  batch?: string
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

/**
 * The Payy card collector merges the notes paid with the card and withdraws
 * them in one burn; only the batch total is public.
 */
export interface CardBatch {
  /** the burn that withdrew the batch */
  burnTx: string
  time: number
  /** earliest merge of the batch */
  firstTime: number
  amount: number
  /** card payments merged into the batch */
  notes: number
  recipient: string
  chain?: ChainId
  paidTx?: string
}

/** The re-issue of the previous Payy chain's balances on 2025-09-12 */
export interface Migration {
  start: number
  end: number
  /** notes paid out to wallets */
  released: number
  /** treasury deposits that funded it */
  deposits: number
  deposited: number
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
  /** paid with the Payy card */
  | { type: 'card'; batch: CardBatch }
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
  /** a card payment repeating on the same day and hour of each month */
  recurring?: boolean
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
  | { type: 'migration'; time: number; distribution?: Migration }
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
  /** present when notes of the graph came from the migration distribution */
  migration?: Migration
  /** card batches that notes of the graph were paid into */
  batches: CardBatch[]
  /** traversal stopped at the node limit */
  truncated: boolean
}

export interface AddressSummary {
  address: string
  label?: string
  withdrawals: Withdrawal[]
  deposits: Deposit[]
}

export type Resolved =
  | { type: 'address'; address: string }
  | { type: 'txn'; hash: string }
  | { type: 'note'; commitment: string; createdTx?: string; spentTx?: string }
  | { type: 'unknown' }

/** ENS and GNS primary names by lowercase address, verified both ways */
export type Names = Record<string, { ens?: string; gns?: string }>

export interface Status {
  payyHeight?: number
  txns: number
  notes: number
  deposits: number
  withdrawals: number
  l1: Record<ChainId, { block: number } | undefined>
}
