import { TxKind } from '../protocol'
import type { Bounds } from './amounts'
import type { Subgraph, TxnRow } from './closure'
import type { Share } from './types'

export interface Flow {
  /** by note commitment: how much of the note can end up in the focus */
  notes: Map<string, number>
  /** by tx hash: how much of what the tx created can end up in the focus */
  txns: Map<string, number>
  /** by mint tx hash */
  shares: Map<string, Share>
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

  const shares = new Map<string, Share>()
  for (const mint of order) {
    if (mint.kind !== TxKind.Mint) continue
    const max = sub.truncated
      ? undefined
      : Math.min(
          total,
          upTo(
            (t) => (t.hash === mint.hash ? mint.amount : 0),
            () => 0,
          ),
        )
    // everything else: the other deposits and the notes from outside the view
    const other = upTo((t) => (t.hash === mint.hash ? 0 : minted(t)), hi)
    const min = Math.max(0, total - other)
    shares.set(mint.hash, {
      min: max === undefined ? min : Math.min(min, max),
      max,
    })
  }
  return { notes, txns, shares }
}
