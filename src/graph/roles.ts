import { all, type Db, getSync, one, setSync, transaction } from '../db'
import { log } from '../log'
import { CARD_SETTLEMENT, MIGRATION_DISTRIBUTION, TxKind } from '../protocol'
import type { NoteRow, TxnRow } from './closure'

/**
 * Two kinds of Payy-operated activity are treated as one unit each instead
 * of being walked through, because walking through them joins unrelated
 * wallets into one graph:
 *
 * - The migration distribution: the tree of payouts that re-issued the
 *   balances of the previous Payy chain on 2025-09-12. Its notes are where
 *   the history of every older wallet starts.
 * - Card batches: the Payy card collector merges the notes that users pay
 *   with the card, two at a time, and withdraws each batch in one burn to
 *   the card settlement contract. A batch shows only its total.
 *
 * Both are identified from the spend graph alone, by the rules below, and
 * stored in the `role` table.
 */
export enum Role {
  Migration = 1,
  Card = 2,
}

export interface RoleRow {
  tx: string
  role: Role
  /** card: the burn tx that settles the batch; migration: 'migration' */
  batch: string
}

export interface CardBatchRow {
  burn_tx: string
  height: number
  time: number
  amount: number
  notes: number
  first_time: number
}

export interface MigrationSummary {
  start: number
  end: number
  /** notes paid out to wallets */
  released: number
  /** treasury deposits merged into the distribution */
  deposits: number
  deposited: number
}

const MIGRATION_KEY = 'roles_migration'
const CARD_KEY = 'roles_card_height'
/**
 * A payout that starts a further chain is soon followed by this many
 * payouts in a row, each within FAST seconds of the previous one, which a
 * wallet spending its note does not do. (The chains run at one payout every
 * two to four seconds.)
 */
const CHAIN_EVIDENCE = 5
const FAST = 10

export function roleOf(db: Db, tx: string): RoleRow | undefined {
  return one<RoleRow>(db, 'select * from role where tx = ?', tx)
}

export function cardBatch(db: Db, burnTx: string): CardBatchRow | undefined {
  return one<CardBatchRow>(
    db,
    'select * from card_batch where burn_tx = ?',
    burnTx,
  )
}

export function migrationSummary(db: Db): MigrationSummary | undefined {
  const value = getSync(db, MIGRATION_KEY)
  return value ? (JSON.parse(value) as MigrationSummary) : undefined
}

/** Brings the role table up to date with the indexed history */
export function deriveRoles(db: Db): void {
  if (!getSync(db, MIGRATION_KEY)) {
    const found = findMigration(db)
    if (found) {
      transaction(db, () => {
        const insert = db.prepare(
          `insert into role (tx, role, batch) values (?, ${Role.Migration}, 'migration')
           on conflict (tx) do nothing`,
        )
        for (const h of found.txs) insert.run(h)
        setSync(db, MIGRATION_KEY, JSON.stringify(found.summary))
      })
      log('migration distribution', { ...found.summary, txs: found.txs.size })
    }
  }
  deriveCardBatches(db)
}

/**
 * The distribution is a tree of payout chains grown from the first treasury
 * deposit. Each payout is a send with one input and two outputs: output 0
 * to a wallet, output 1 the change that the next payout spends. Treasury
 * top-ups are mints that consume the change. Now and then a payout's
 * output 0 starts a further chain instead of reaching a wallet; that is
 * recognised by the pace of the payouts that follow. Everything stays
 * inside the distribution window; the change of a chain is always followed,
 * however long it waited.
 */
export function findMigration(
  db: Db,
): { txs: Set<string>; summary: MigrationSummary } | undefined {
  const { root, start, end } = MIGRATION_DISTRIBUTION
  if (!one(db, 'select 1 from txn where hash = ?', root)) return undefined
  const txns = new Map(
    all<TxnRow>(
      db,
      'select * from txn where time >= ? and time < ?',
      start,
      end,
    ).map((t) => [t.hash, t]),
  )
  const inputsOf = db.prepare('select * from note where spent_tx = ?')
  const outputsOf = db.prepare('select * from note where created_tx = ?')
  const inputs = new Map<string, NoteRow[]>()
  const outputs = new Map<string, NoteRow[]>()
  for (const h of txns.keys()) {
    inputs.set(h, inputsOf.all(h) as unknown as NoteRow[])
    outputs.set(h, outputsOf.all(h) as unknown as NoteRow[])
  }
  const output = (h: string, i: number) =>
    outputs.get(h)?.find((n) => n.created_idx === i)
  /** a payout (one input, two outputs) or a top-up (a mint consuming the change) */
  const isStep = (h: string | null): h is string => {
    const t = h ? txns.get(h) : undefined
    if (!t || !h || inputs.get(h)?.length !== 1) return false
    const outs = outputs.get(h)?.length ?? 0
    return (
      (t.kind === TxKind.Send && outs === 2) ||
      (t.kind === TxKind.Mint && outs === 1)
    )
  }
  const change = (h: string) =>
    output(h, txns.get(h)?.kind === TxKind.Mint ? 0 : 1)
  // a chain may start slowly but speeds up within its first few payouts
  const startsChain = (h: string) => {
    let prev: string | undefined
    let cur: string | null = h
    let fast = 0
    for (let i = 0; i < CHAIN_EVIDENCE * 3 && fast < CHAIN_EVIDENCE; i++) {
      if (!isStep(cur)) return false
      const gap = prev
        ? (txns.get(cur)?.time ?? 0) - (txns.get(prev)?.time ?? 0)
        : Infinity
      fast = gap <= FAST ? fast + 1 : 0
      prev = cur
      cur = change(cur)?.spent_tx ?? null
    }
    return fast >= CHAIN_EVIDENCE
  }

  const txs = new Set<string>()
  const queue = [root]
  for (const h of queue) {
    if (txs.has(h)) continue
    txs.add(h)
    const next = change(h)?.spent_tx ?? null
    if (isStep(next)) queue.push(next)
    const payout = txns.get(h)?.kind === TxKind.Send ? output(h, 0) : undefined
    const spender = payout?.spent_tx ?? null
    if (spender && startsChain(spender)) queue.push(spender)
  }

  let released = 0
  let deposits = 0
  let deposited = 0
  let last = 0
  for (const h of txs) {
    const t = txns.get(h)
    if (!t) continue
    last = Math.max(last, t.time)
    if (t.kind === TxKind.Mint) {
      deposits++
      deposited += t.amount
    }
    for (const n of outputs.get(h) ?? []) {
      if (!n.spent_tx || !txs.has(n.spent_tx)) released++
    }
  }
  return {
    txs,
    summary: {
      start: txns.get(root)?.time ?? start,
      end: last,
      released,
      deposits,
      deposited,
    },
  }
}

/**
 * A card batch is found from its burn: walking back from it, every merge
 * (a send with two inputs and one output) belongs to the collector, and the
 * notes those merges consume from anything else are the card payments.
 * Burns are processed in height order as they are indexed; the merges of a
 * batch always come before its burn.
 */
export function deriveCardBatches(db: Db): void {
  const from = Number(getSync(db, CARD_KEY) ?? -1)
  const placeholders = CARD_SETTLEMENT.map(() => '?').join(', ')
  const burns = all<TxnRow>(
    db,
    `select * from txn where kind = ${TxKind.Burn} and height > ?
     and burn_addr in (${placeholders}) order by height`,
    from,
    ...CARD_SETTLEMENT,
  )
  if (burns.length === 0) return
  const getTxn = db.prepare('select * from txn where hash = ?')
  const inputsOf = db.prepare('select * from note where spent_tx = ?')
  const countOutputs = db.prepare(
    'select count(*) as n from note where created_tx = ?',
  )
  const insertRole = db.prepare(
    `insert into role (tx, role, batch) values (?, ${Role.Card}, ?)
     on conflict (tx) do nothing`,
  )
  const insertBatch = db.prepare(
    `insert into card_batch (burn_tx, height, time, amount, notes, first_time)
     values (?, ?, ?, ?, ?, ?) on conflict (burn_tx) do nothing`,
  )
  const isMerge = (t: TxnRow) =>
    t.kind === TxKind.Send &&
    (inputsOf.all(t.hash) as unknown[]).length === 2 &&
    (countOutputs.get(t.hash) as { n: number }).n === 1

  // in chunks, so a first run over the whole history stays interruptible
  for (let i = 0; i < burns.length; i += 200) {
    const chunk = burns.slice(i, i + 200)
    transaction(db, () => {
      for (const burn of chunk) {
        const members = new Set<string>([burn.hash])
        let notes = 0
        let first = burn.time
        const queue = [burn.hash]
        for (const h of queue) {
          for (const n of inputsOf.all(h) as unknown as NoteRow[]) {
            const creator = n.created_tx
              ? (getTxn.get(n.created_tx) as TxnRow | undefined)
              : undefined
            if (creator && !members.has(creator.hash) && isMerge(creator)) {
              members.add(creator.hash)
              first = Math.min(first, creator.time)
              queue.push(creator.hash)
            } else {
              notes++
            }
          }
        }
        for (const h of members) insertRole.run(h, burn.hash)
        insertBatch.run(
          burn.hash,
          burn.height,
          burn.time,
          burn.amount,
          notes,
          first,
        )
      }
      const last = chunk[chunk.length - 1]
      if (last) setSync(db, CARD_KEY, String(last.height))
    })
  }
  log('card batches', { burns: burns.length })
}
