import { all, type Db, one, transaction } from '../db'
import { log } from '../log'
import { labelOf } from '../protocol'

/**
 * Addresses that belong to one owner, as far as the data links them. Two
 * kinds of link, kept apart because they are not equally certain:
 *
 * - by events: a Payy deposit whose USDC an Across fill delivered belongs
 *   with the address that deposited into Across on the other chain; the
 *   fill names both (src/l1/bridges.ts). One address on several chains is
 *   one address, since the Payy app derives one per user.
 * - by payment: an address is taken to belong to whoever paid it just
 *   before it bridged or deposited. That holds for a user paying their own
 *   Payy address, not for a service paying many users, so a payer counts
 *   only when it paid at most MAX_RECEIVERS addresses, is not a contract
 *   (a router's own sender counts instead, the wallet that swapped) and has
 *   no public label (exchanges, Payy's own addresses). Groups that rely on
 *   it are marked, and the UI says so.
 *
 * Every group gets a root: the address it is shown by, a named one if any,
 * else a payer (the owner's own wallet), else the lowest address.
 */

/** A payer of more addresses than this is taken to be a service */
export const MAX_RECEIVERS = 2

export interface Identity {
  root: string
  size: number
  /** the group relies on who paid in, not only on bridge events */
  paid: boolean
}

export function identityOf(db: Db, address: string): Identity | undefined {
  const row = one<{ root: string; size: number; paid: number }>(
    db,
    'select root, size, paid from identity where address = ?',
    address.toLowerCase(),
  )
  return row && { root: row.root, size: row.size, paid: row.paid === 1 }
}

/** The addresses of a group, root first */
export function membersOf(db: Db, root: string): string[] {
  const rows = all<{ address: string }>(
    db,
    'select address from identity where root = ? order by address = ? desc, address',
    root,
    root,
  )
  return rows.length ? rows.map((r) => r.address) : [root]
}

interface Edge {
  a: string
  b: string
  paid: boolean
}

/** Links of both kinds from the bridge tables; services left out */
export function identityEdges(db: Db): Edge[] {
  const bridged = all<{ depositor: string; origin: string }>(
    db,
    `select d.depositor, b.origin_depositor as origin from bridge_in b
     join deposit d on d.chain = b.chain and d.mint_hash = b.mint_hash
     where b.fill_tx is not null and b.origin_depositor is not null`,
  )
  const payments = [
    ...all<{ payer: string; to: string; kind: string }>(
      db,
      `select p.payer, b.origin_depositor as "to", p.kind from bridge_payer p
       join bridge_in b on b.chain = p.chain and b.mint_hash = p.mint_hash`,
    ),
    // a router's payment counts as the swap sender's
    ...all<{ payer: string; to: string; kind: string }>(
      db,
      `select case when b.fund_kind = 'contract' then b.fund_sender
                   else b.fund_from end as payer,
         d.depositor as "to",
         case when b.fund_kind = 'contract' then 'eoa' else b.fund_kind end as kind
       from bridge_in b
       join deposit d on d.chain = b.chain and d.mint_hash = b.mint_hash
       where b.fill_tx is null and b.fund_from is not null`,
    ),
  ].filter((p) => p.payer && p.payer !== p.to && p.kind !== 'contract')
  const receivers = new Map<string, Set<string>>()
  for (const p of payments) {
    const set = receivers.get(p.payer) ?? new Set()
    set.add(p.to)
    receivers.set(p.payer, set)
  }
  const personal = (payer: string) =>
    (receivers.get(payer)?.size ?? 0) <= MAX_RECEIVERS && !labelOf(payer)
  return [
    ...bridged.map((r) => ({ a: r.depositor, b: r.origin, paid: false })),
    ...payments
      .filter((p) => personal(p.payer))
      .map((p) => ({ a: p.payer, b: p.to, paid: true })),
  ]
}

/** Groups the linked addresses; returns address -> identity */
export function groupIdentities(
  edges: Edge[],
  named: (address: string) => boolean,
): Map<string, Identity> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) ?? r
    // path compression
    let c = x
    while (c !== r) {
      const next = parent.get(c) ?? r
      parent.set(c, r)
      c = next
    }
    return r
  }
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x)
  }
  const payers = new Set<string>()
  for (const e of edges) {
    add(e.a)
    add(e.b)
    if (e.paid) payers.add(e.a)
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const groups = new Map<string, string[]>()
  for (const x of parent.keys()) {
    const r = find(x)
    groups.set(r, [...(groups.get(r) ?? []), x])
  }
  const paid = new Set<string>()
  for (const e of edges) if (e.paid) paid.add(find(e.a))
  const result = new Map<string, Identity>()
  for (const [r, members] of groups) {
    const rank = (x: string) => (named(x) ? 0 : payers.has(x) ? 1 : 2)
    const root = [...members].sort(
      (x, y) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0),
    )[0]
    if (!root) continue
    for (const m of members) {
      result.set(m, { root, size: members.length, paid: paid.has(r) })
    }
  }
  return result
}

/** Derives the identity table from the bridge tables and the names */
export function deriveIdentities(db: Db): void {
  const names = new Set(
    all<{ address: string }>(
      db,
      'select address from name where ens is not null or gns is not null',
    ).map((r) => r.address),
  )
  const groups = groupIdentities(identityEdges(db), (a) => names.has(a))
  transaction(db, () => {
    db.exec('delete from identity')
    const insert = db.prepare(
      'insert into identity (address, root, size, paid) values (?, ?, ?, ?)',
    )
    for (const [address, g] of groups) {
      insert.run(address, g.root, g.size, g.paid ? 1 : 0)
    }
  })
  const roots = new Set([...groups.values()].map((g) => g.root))
  log('identities', { addresses: groups.size, groups: roots.size })
}
