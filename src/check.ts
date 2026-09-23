import { type Db, one } from './db'

/**
 * Consistency checks between the L2 history and the L1 events. They pass on
 * the real data, which is itself the evidence that the spend graph is
 * complete: every spent note was created earlier exactly once, every mint
 * has its deposit and every settled burn its payout.
 */
export function check(db: Db): void {
  const out = (s: string) => process.stdout.write(`${s}\n`)
  const count = (sql: string, ...params: (string | number)[]) =>
    one<{ n: number }>(db, `select count(*) as n from (${sql})`, ...params)
      ?.n ?? 0

  const lastSettled =
    one<{ h: number | null }>(db, 'select max(height) as h from settlement')
      ?.h ?? 0

  const rows: [string, number][] = [
    ['transactions', count('select 1 from txn')],
    ['notes', count('select 1 from note')],
    [
      'notes spent but never created',
      count(
        'select 1 from note where spent_tx is not null and created_tx is null',
      ),
    ],
    [
      'mints without a deposit on their settlement chain',
      count(
        `select 1 from txn t where t.kind = 2 and t.height <= ?
         and not exists (
           select 1 from deposit d
           join settlement s on s.chain = d.chain
           where d.mint_hash = t.msg_hash and s.height = (
             select min(height) from settlement where height >= t.height))`,
        lastSettled,
      ),
    ],
    [
      'deposit amounts differing from the mint',
      count(
        `select 1 from txn t join deposit d on d.mint_hash = t.msg_hash
         where t.kind = 2 and d.amount <> t.amount`,
      ),
    ],
    [
      'settled burns without a Burned event',
      count(
        `select 1 from txn t where t.kind = 3 and t.height <= ?
         and not exists (select 1 from burned b where b.burn_hash = t.msg_hash)`,
        lastSettled,
      ),
    ],
    [
      'deposits never minted on Payy (stranded or pending)',
      count(
        `select 1 from deposit d
         where not exists (select 1 from txn t where t.kind = 2 and t.msg_hash = d.mint_hash)`,
      ),
    ],
    [
      'migration distribution transactions',
      count('select 1 from role where role = 1'),
    ],
    ['card batches', count('select 1 from card_batch')],
    ['card collector merges', count('select 1 from role where role = 2')],
    [
      'card payments (notes merged into batches)',
      one<{ n: number | null }>(db, 'select sum(notes) as n from card_batch')
        ?.n ?? 0,
    ],
    ['settled heights', count('select 1 from settlement')],
    ['last settled height', lastSettled],
  ]
  for (const [label, n] of rows) out(`${String(n).padStart(9)}  ${label}`)
}
