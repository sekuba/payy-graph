/** Shared between the API and the web UI. Amounts are in micro USDC. */

import type { ChainId, TxKind } from '../protocol'

export interface TxnNode {
  hash: string
  height: number
  time: number
  kind: TxKind
  /** minted or burned amount */
  amount: number
  /**
   * how much of what it created can end up in the focused withdrawals; set
   * on backward views of withdrawals (src/graph/sources.ts)
   */
  reach?: number
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
  /** how much of it can end up in the focused withdrawals, like `TxnNode.reach` */
  reach?: number
}

/** The deposits of one sender behind withdrawals, bounded together */
export interface Sender {
  /** the owner's address (see Owner), or the one address */
  address: string
  /** EVM chain id the deposits were bridged from, if they were */
  chain?: number
  /** its addresses behind these deposits, when there are several */
  addresses?: string[]
  /** grouping them relies on who paid in */
  paid?: boolean
  deposits: number
  amount: number
  first: number
  last: number
  share: Share
}

/** The withdrawals to one recipient ahead of a deposit, bounded */
export interface Recipient {
  address: string
  chain?: ChainId
  withdrawals: number
  amount: number
  first: number
  last: number
  /** the withdrawal, when there is one */
  burnTx?: string
  /** the group the recipient belongs to, if any */
  owner?: Owner
  /** how much of these withdrawals can have come from the deposit */
  share: Share
}

/** How much of the focused withdrawals can have come from one deposit */
export interface Share {
  min: number
  /** missing when the graph was truncated: funds can reach it unseen */
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
  /** its part in the focused withdrawals (src/graph/sources.ts) */
  share?: Share
  /** set when its USDC was bridged in from another chain just before */
  bridge?: Bridged
  /** not bridged: who paid the deposit address just before it deposited */
  funding?: {
    address: string
    tx: string
    /** the router or contract that sent the USDC, when it was not `address` */
    via?: string
  }
  /** who it belongs to, as far as the data links it (src/graph/identity.ts) */
  owner?: Owner
}

/** A group of addresses the data links to one owner */
export interface Owner {
  /** the address the group is shown by */
  address: string
  size: number
  /** the group relies on who paid in, not only on bridge events */
  paid: boolean
}

/** A deposit's USDC bridged in from another chain (src/l1/bridges.ts) */
export interface Bridged {
  via: 'Across'
  /** EVM chain id it came from */
  chain: number
  /** the address that deposited into Across there */
  depositor: string
  /** the fill on the settlement chain that paid the Payy depositor */
  fillTx: string
  /** the transfer into Across on the origin chain, once looked up */
  originTx?: string
  originTime?: number
  /** the transfer that paid `depositor` shortly before it bridged */
  funder?: {
    address: string
    tx: string
    time: number
    /** in micro units, when the token is one of the known dollar tokens */
    amount?: number
    /** that token, e.g. USDT when Across swapped it to USDC */
    symbol?: string
  }
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
  /** the group the recipient belongs to, when the data links it to others */
  owner?: Owner
  /** transactions between the focused transaction and this withdrawal */
  hops?: number
  /** how much of what it kept can end up in the focus, like `TxnNode.reach` */
  reach?: number
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
  /** notes it consumed and created (a proof has two slots of each) */
  inputs: number
  outputs: number
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
  | {
      type: 'migration'
      time: number
      distribution?: Migration
      /** what the migrated note held, as far as the history determines it */
      value?: number
      min?: number
      max?: number
    }
  | { type: 'merge'; time: number }
  | { type: 'limit' }

export interface Path {
  withdrawal: Withdrawal
  /** oldest first */
  hops: PathHop[]
  origin: PathOrigin
  /** the deposits in its history with their share of it, largest first */
  sources: Deposit[]
  /**
   * the same by who sent them (on the other chain when bridged), each
   * sender's deposits bounded together, largest first
   */
  senders: Sender[]
  /**
   * notes from other histories merged in along the way; each held less than
   * a cent, else the walk would have stopped there
   */
  merged: {
    txHash: string
    time: number
    value?: number
    min: number
    max?: number
    /** what the merged note descends from, nearest first */
    from: {
      withdrawals: Withdrawal[]
      deposits: Deposit[]
    }
  }[]
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
  /** seen back from withdrawals: the deposits by sender, largest share first */
  senders?: Sender[]
  /** seen forward from one deposit: its withdrawals by recipient */
  recipients?: Recipient[]
  /** and at most how much of it went into card payments or is unspent */
  spread?: { card?: number; unspent?: number; truncated: boolean }
  /** traversal stopped at the node limit */
  truncated: boolean
}

export interface AddressSummary {
  address: string
  label?: string
  /** the group the data links it to, and the group's other addresses */
  owner?: Owner
  addresses?: string[]
  withdrawals: Withdrawal[]
  deposits: Deposit[]
  /** the senders whose deposits provably supplied its withdrawals */
  fundedBy: Link[]
  /** the recipients of withdrawals its deposits provably supplied */
  funded: Link[]
}

/** Another address and the withdrawals that link them, from the traces */
export interface Link {
  address: string
  withdrawals: number
  /** at least this much of those withdrawals, together */
  amount: number
}

export type Resolved =
  | { type: 'address'; address: string }
  | { type: 'txn'; hash: string }
  | { type: 'note'; commitment: string; createdTx?: string; spentTx?: string }
  /** `name`: an ENS or GNS name no address in the index has */
  | { type: 'unknown'; name?: string }

/** Where a withdrawal's funds came from (src/graph/traces.ts) */
export interface Trace {
  /** how its history begins, walking back along its own notes */
  origin: PathOrigin['type']
  /** the deposit it begins with, when the origin is one deposit */
  source?: {
    depositor: string
    chain: ChainId
    time: number
    amount: number
    /** transactions between the deposit and the withdrawal */
    hops: number
  }
  /**
   * the sender whose deposits provably supplied the largest part of it (at
   * least a cent), with that part
   */
  sender?: {
    address: string
    chain?: number
    deposits: number
    min: number
    max?: number
    /** the sender is the recipient: the same address, or the same owner */
    same?: 'address' | 'owner'
    /** grouping its deposits relies on who paid in */
    paid?: boolean
  }
  /** distinct addresses behind the deposits in its history */
  depositors: number
  /** transactions to the nearest of those deposits */
  nearest?: number
  /** the history was larger than the walk's limit; counts are minimums */
  truncated: boolean
}

/**
 * Deposits of exactly a withdrawal's amount in the days before it, for an
 * amount that is not a whole number of USDC: the latest one, and how many
 */
export interface AmountMatch {
  count: number
  depositor: string
  chain: ChainId
  time: number
}

/** One row of the live view */
export type LiveEvent =
  | {
      type: 'withdrawal'
      withdrawal: Withdrawal
      trace?: Trace
      /** deposits of exactly this amount shortly before (src/graph/live.ts) */
      match?: AmountMatch
      /** this is the `nth` of `of` withdrawals to the same recipient */
      reuse?: { nth: number; of: number }
    }
  | { type: 'deposit'; deposit: Deposit }
  | { type: 'card'; batch: CardBatch }

export interface LiveStats {
  payyHeight?: number
  /** time of the latest Payy block */
  payyTime?: number
  txns: number
  /** latest settled height and its L1 time, per chain */
  settled: Partial<Record<ChainId, { height: number; time: number }>>
  /** USDC held by the Rollup contract, per chain */
  locked: Partial<Record<ChainId, number>>
  day: {
    deposits: { count: number; amount: number }
    withdrawals: { count: number; amount: number }
    card: { payments: number; batches: number; amount: number }
  }
  /** what the public data reveals, over the last 7 days and overall */
  privacy: Record<'week' | 'all', PrivacyStats>
}

/** The headline figures of the live view; definitions in src/graph/live.ts */
export interface PrivacyStats {
  /** withdrawals (not card batches), and those traced so far */
  withdrawals: number
  traced: number
  /** all but under a cent provably from the deposits of one sender */
  fromOneSender: number
  /** their recipients, and those that received more than one withdrawal */
  recipients: number
  reused: number
  /** deposits, those bridged in through Across, and those whose sender on
   * the other chain is known */
  deposits: number
  bridged: number
  bridgedKnown: number
}

/** An address with a label or a name, and everything it did with Payy */
export interface NamedAddress {
  address: string
  label?: string
  ens?: string
  gns?: string
  deposits: { count: number; amount: number }
  withdrawals: { count: number; amount: number }
  first: number
  last: number
}

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
