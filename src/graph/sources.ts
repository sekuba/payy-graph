import { TxKind } from '../protocol'
import type { Bounds } from './amounts'
import type { Subgraph, TxnRow } from './closure'
import { Role } from './roles'
import type { Share } from './types'

export interface Flow {
  /** by note commitment: how much of the note can end up in the focus */
  notes: Map<string, number>
  /** by tx hash: how much of what the tx created can end up in the focus */
  txns: Map<string, number>
  /** by mint tx hash */
  shares: Map<string, Share>
  /** by group, for the groups of mints passed in (e.g. by sender) */
  groups: Map<string, Share>
}

/**
 * Which deposits can have funded a set of withdrawals, and how much of them.
 * USDC is fungible inside a transaction, so nothing tells which input paid
 * which output, but every note caps what passes through it:
 *
 * - Walking back from the withdrawals: of a note, at most its value and at
 *   most what its spender passes on towards the withdrawals can end up in
 *   them (its reach); of a transaction, at most what its spenders pass on.
 * - Walking forward from a deposit: a note carries at most its value, its
 *   reach, and what of the deposit flowed into its transaction. What
 *   arrives at the withdrawals is the deposit's largest possible share. A
 *   deposit whose funds reach them only through a note of 0.007 USDC
 *   contributed at most 0.007, however large it was.
 * - Walking forward from everything else, the other deposits and the notes
 *   from outside the view, the same way: the part of the withdrawals they
 *   cannot cover came from this deposit, its smallest possible share.
 *
 * `sub` must be the backward closure of `focus` (all burns), so that every
 * note spent outside it is a side branch whose funds do not reach the focus.
 * When the closure was truncated that is not known, and only the lower
 * bounds are given. Notes from the migration distribution count as other
 * funds: the distribution was paid from treasury deposits only (roles.ts).
 */
export function flowInto(
  sub: Pick<Subgraph, 'txns' | 'notes' | 'truncated'>,
  bounds: Map<string, Bounds>,
  focus: string[],
  /** a group for some mints, by mint tx hash; each group is bounded as one */
  groupOf: (mint: string) => string | undefined = () => undefined,
): Flow {
  const inputs = new Map<string, string[]>()
  const outputs = new Map<string, string[]>()
  for (const t of sub.txns.keys()) {
    inputs.set(t, [])
    outputs.set(t, [])
  }
  for (const n of sub.notes.values()) {
    if (n.spent_tx) inputs.get(n.spent_tx)?.push(n.commitment)
    if (n.created_tx) outputs.get(n.created_tx)?.push(n.commitment)
  }
  const order = [...sub.txns.values()].sort(
    (a, b) => a.height - b.height || a.idx - b.idx,
  )
  const hi = (n: string) =>
    bounds.get(n)?.value ?? bounds.get(n)?.max ?? Number.POSITIVE_INFINITY
  const burned = new Map(
    focus.flatMap((h) => {
      const t = sub.txns.get(h)
      return t?.kind === TxKind.Burn ? [[h, t.amount] as const] : []
    }),
  )
  const total = [...burned.values()].reduce((a, b) => a + b, 0)

  const notes = new Map<string, number>()
  const txns = new Map<string, number>()
  if (!sub.truncated) {
    for (const t of [...order].reverse()) {
      // grouped by spender: two notes into the same transaction (a split
      // that merges back) pass on at most what that transaction passes on
      const into = new Map<string, number>()
      for (const n of outputs.get(t.hash) ?? []) {
        const spender = sub.notes.get(n)?.spent_tx
        if (spender && txns.has(spender)) {
          into.set(spender, (into.get(spender) ?? 0) + hi(n))
        }
      }
      let passed = burned.get(t.hash) ?? 0
      for (const [spender, sum] of into) {
        passed += Math.min(sum, txns.get(spender) ?? 0)
      }
      txns.set(t.hash, passed)
      for (const n of inputs.get(t.hash) ?? []) {
        notes.set(n, Math.min(hi(n), passed))
      }
    }
  }

  // Upper bound on what the funds of some sources put into the focus:
  // forward, each note carries at most its value, what flowed into its
  // transaction, and what of it can reach the focus at all. The last cap
  // keeps a split that merges back from counting twice.
  const upTo = (
    source: (t: TxnRow) => number,
    outside: (note: string) => number,
  ) => {
    const carried = new Map<string, number>()
    let into = 0
    for (const t of order) {
      const inflow =
        source(t) +
        (inputs.get(t.hash) ?? []).reduce(
          (a, n) =>
            a +
            (sub.txns.has(sub.notes.get(n)?.created_tx ?? '')
              ? (carried.get(n) ?? 0)
              : outside(n)),
          0,
        )
      for (const n of outputs.get(t.hash) ?? []) {
        const reach = sub.truncated ? hi(n) : (notes.get(n) ?? 0)
        carried.set(n, Math.min(hi(n), inflow, reach))
      }
      into += Math.min(burned.get(t.hash) ?? 0, inflow)
    }
    return into
  }
  const minted = (t: TxnRow) => (t.kind === TxKind.Mint ? t.amount : 0)

  /** the share of the deposits `members` together */
  const shareOf = (members: Set<string>): Share => {
    const amount = order
      .filter((t) => members.has(t.hash))
      .reduce((a, t) => a + t.amount, 0)
    const max = sub.truncated
      ? undefined
      : Math.min(
          total,
          // a split that rejoins can make the walk count a deposit twice
          amount,
          upTo(
            (t) => (members.has(t.hash) ? t.amount : 0),
            () => 0,
          ),
        )
    // everything else: the other deposits and the notes from outside the view
    const other = upTo((t) => (members.has(t.hash) ? 0 : minted(t)), hi)
    const min = Math.max(0, total - other)
    return { min: max === undefined ? min : Math.min(min, max), max }
  }
  const shares = new Map<string, Share>()
  const members = new Map<string, Set<string>>()
  for (const mint of order) {
    if (mint.kind !== TxKind.Mint) continue
    shares.set(mint.hash, shareOf(new Set([mint.hash])))
    const group = groupOf(mint.hash)
    if (group === undefined) continue
    const set = members.get(group) ?? new Set()
    set.add(mint.hash)
    members.set(group, set)
  }
  const groups = new Map<string, Share>()
  for (const [group, set] of members) {
    // a group of one is that deposit
    const [only] = set
    groups.set(
      group,
      set.size === 1 && only
        ? (shares.get(only) ?? shareOf(set))
        : shareOf(set),
    )
  }
  return { notes, txns, shares, groups }
}

/** Where a deposit's funds can have gone, as far as the notes bound it */
export interface Spread {
  /** by burn tx: how much of the withdrawal can have come from the deposit */
  withdrawals: Map<string, Share>
  /** at most this went into card payments, and at most this is unspent */
  card?: number
  unspent?: number
}

/**
 * The mirror of flowInto, walking forward from one deposit through `sub`,
 * its forward closure. For each withdrawal ahead: at most what of the
 * deposit can have flowed into it (a note carries at most its value and
 * what of the deposit entered its transaction), and at least what the rest
 * cannot cover (notes merged in from outside the view count as other funds
 * at their full bound). Card payments and unspent notes get upper bounds
 * the same way. When the closure was truncated, paths to a withdrawal can
 * run through transactions not loaded, so only the lower bounds are given.
 */
export function spreadFrom(
  sub: Pick<Subgraph, 'txns' | 'notes' | 'boundaries' | 'truncated'>,
  bounds: Map<string, Bounds>,
  mint: string,
): Spread {
  const deposit = sub.txns.get(mint)
  const inputs = new Map<string, string[]>()
  const outputs = new Map<string, string[]>()
  for (const t of sub.txns.keys()) {
    inputs.set(t, [])
    outputs.set(t, [])
  }
  for (const n of sub.notes.values()) {
    if (n.spent_tx) inputs.get(n.spent_tx)?.push(n.commitment)
    if (n.created_tx) outputs.get(n.created_tx)?.push(n.commitment)
  }
  const order = [...sub.txns.values()].sort(
    (a, b) => a.height - b.height || a.idx - b.idx,
  )
  const hi = (n: string) =>
    bounds.get(n)?.value ?? bounds.get(n)?.max ?? Number.POSITIVE_INFINITY
  const amount = deposit?.amount ?? 0
  /** what of `source` each note carries at most, and what each burn takes */
  const carry = (
    source: (t: TxnRow) => number,
    outside: (n: string) => number,
  ) => {
    const carried = new Map<string, number>()
    const burned = new Map<string, number>()
    for (const t of order) {
      const inflow =
        source(t) +
        (inputs.get(t.hash) ?? []).reduce(
          (a, n) =>
            a +
            (sub.txns.has(sub.notes.get(n)?.created_tx ?? '')
              ? (carried.get(n) ?? 0)
              : outside(n)),
          0,
        )
      for (const n of outputs.get(t.hash) ?? []) {
        carried.set(n, Math.min(hi(n), inflow))
      }
      if (t.kind === TxKind.Burn) burned.set(t.hash, Math.min(t.amount, inflow))
    }
    return { carried, burned }
  }
  const mine = carry(
    (t) => (t.hash === mint ? amount : 0),
    () => 0,
  )
  const other = carry(
    (t) => (t.kind === TxKind.Mint && t.hash !== mint ? t.amount : 0),
    hi,
  )
  const withdrawals = new Map<string, Share>()
  for (const t of order) {
    if (t.kind !== TxKind.Burn) continue
    const max = sub.truncated
      ? undefined
      : Math.min(amount, mine.burned.get(t.hash) ?? 0)
    const min = Math.max(0, t.amount - (other.burned.get(t.hash) ?? 0))
    withdrawals.set(t.hash, {
      min: max === undefined ? min : Math.min(min, max),
      max,
    })
  }
  if (sub.truncated) return { withdrawals }
  let card = 0
  let unspent = 0
  for (const n of sub.notes.values()) {
    if (!sub.txns.has(n.created_tx ?? '')) continue
    const c = mine.carried.get(n.commitment) ?? 0
    if (!n.spent_tx) unspent += c
    else if (sub.boundaries.get(n.spent_tx)?.role === Role.Card) card += c
  }
  return {
    withdrawals,
    card: Math.min(amount, card),
    unspent: Math.min(amount, unspent),
  }
}
