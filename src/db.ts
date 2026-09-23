import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export type Db = DatabaseSync

/**
 * One table per kind of fact. Hashes and commitments are stored as lowercase
 * hex without the 0x prefix; addresses as lowercase hex with the prefix.
 * Amounts are integers in the token's smallest unit (USDC has 6 decimals).
 */
const SCHEMA = `
  -- Payy transactions: one row per utxo proof included in a block
  create table if not exists txn (
    hash text primary key,
    height integer not null,
    idx integer not null,       -- position in block
    time integer not null,      -- block time reported by the node
    kind integer not null,      -- 1 send, 2 mint, 3 burn
    amount integer not null,    -- minted or burned amount, 0 for sends
    msg_hash text not null,     -- mint hash or burn hash
    burn_addr text              -- L1 recipient for burns
  );
  create index if not exists txn_height on txn(height, idx);
  create index if not exists txn_mint_hash on txn(msg_hash) where kind = 2;
  create index if not exists txn_burn_addr on txn(burn_addr) where kind = 3;

  -- Notes: each commitment is created by one tx and spent by at most one
  create table if not exists note (
    commitment text primary key,
    created_tx text,
    created_idx integer,
    spent_tx text,
    spent_idx integer
  );
  create index if not exists note_created_tx on note(created_tx);
  create index if not exists note_spent_tx on note(spent_tx);

  -- L1 deposits: MintAdded joined with the USDC transfer in the same tx.
  -- The same mint hash can be deposited on both chains (deposits stranded on
  -- Polygon at the migration were redone on Ethereum), so the key includes
  -- the chain and the settlement of the mint's height decides which one counts.
  create table if not exists deposit (
    chain text not null,
    mint_hash text not null,
    block integer not null,
    tx text not null,
    log_index integer not null,
    time integer not null,
    depositor text not null,
    amount integer not null,
    primary key (chain, mint_hash)
  );
  create index if not exists deposit_mint_hash on deposit(mint_hash);
  create index if not exists deposit_depositor on deposit(depositor);

  -- Deposits whose USDC arrived by an Across fill of exactly the deposited
  -- amount just before (src/l1/bridges.ts). One row per checked deposit;
  -- fill_tx is null when it did not. On the origin chain: the Across deposit
  -- (origin_tx), what the origin depositor paid into it, and who had paid
  -- the origin depositor just before (funder); funder_checked is set once
  -- that was looked up, whether or not something was found.
  create table if not exists bridge_in (
    chain text not null,
    mint_hash text not null,
    fill_tx text,
    origin_chain integer,
    deposit_id text,            -- Across deposit id, a decimal string
    origin_depositor text,
    origin_tx text,
    origin_time integer,
    origin_token text,          -- what the origin depositor paid in
    origin_amount text,         -- raw token units, a decimal string
    funder text,
    funder_tx text,
    funder_amount text,         -- of origin_token
    funder_time integer,
    funder_checked integer not null default 0,
    primary key (chain, mint_hash)
  );
  create index if not exists bridge_in_funder on bridge_in(funder);
  create index if not exists bridge_in_origin on bridge_in(origin_depositor);

  -- L1 Burned events, as emitted (a fronted withdrawal produces two)
  create table if not exists burned (
    chain text not null,
    tx text not null,
    log_index integer not null,
    block integer not null,
    time integer not null,
    burn_hash text not null,
    recipient text not null,
    substitute integer not null,
    success integer not null,
    primary key (chain, tx, log_index)
  );
  create index if not exists burned_recipient on burned(recipient);
  create index if not exists burned_hash on burned(burn_hash);

  -- L1 state updates: which tx settled which Payy height
  create table if not exists settlement (
    chain text not null,
    height integer not null,
    block integer not null,
    tx text not null,
    time integer not null,
    root text not null,
    primary key (chain, height)
  );
  create index if not exists settlement_height on settlement(height);

  -- Sparse block timestamps used to date L1 events by interpolation
  create table if not exists block_time (
    chain text not null,
    block integer not null,
    time integer not null,
    primary key (chain, block)
  );

  -- Payy-operated transactions the graph treats as one unit instead of
  -- walking through them (src/graph/roles.ts), derived from the history
  create table if not exists role (
    tx text primary key,
    role integer not null,      -- 1 migration distribution, 2 card batch
    batch text not null         -- card: burn tx of the batch
  );
  create index if not exists role_batch on role(batch);

  -- Card batches: the collector's burn to the card settlement and the
  -- number of notes merged into it
  create table if not exists card_batch (
    burn_tx text primary key,
    height integer not null,
    time integer not null,
    amount integer not null,
    notes integer not null,
    first_time integer not null -- earliest merge of the batch
  );

  -- Where each withdrawal's funds came from (src/graph/traces.ts)
  create table if not exists trace (
    burn_tx text primary key,
    height integer not null,
    origin text not null,       -- deposit, migration, merge or limit
    depositor text,             -- origin deposit, when there is one
    deposit_chain text,
    deposit_time integer,
    deposit_amount integer,
    deposit_hops integer,       -- transactions from that deposit
    depositors integer not null, -- distinct depositors in the history
    nearest integer,            -- transactions to the nearest deposit
    truncated integer not null  -- the history walk hit its limit
  );
  create index if not exists trace_height on trace(height);
  create index if not exists deposit_time on deposit(time);
  create index if not exists deposit_amount on deposit(amount, time);

  -- ENS and GNS primary names of L1 addresses, cached
  create table if not exists name (
    address text primary key,
    ens text,
    gns text,
    checked integer not null
  );
  create index if not exists name_ens on name(ens) where ens is not null;
  create index if not exists name_gns on name(gns) where gns is not null;

  create table if not exists sync (
    key text primary key,
    value text not null
  );
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma busy_timeout = 5000') // sync and serve share the file
  db.exec('pragma journal_mode = wal')
  db.exec('pragma synchronous = normal')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** Columns added to existing tables after their first release */
const ADDED: Record<string, Record<string, string>> = {
  trace: {
    sender: 'text', // the sender whose deposits provably supplied most of it
    sender_chain: 'integer', // EVM chain id it bridged from, if it did
    sender_deposits: 'integer',
    sender_min: 'integer', // its share of the withdrawal
    sender_max: 'integer',
  },
}

function migrate(db: Db): void {
  for (const [table, columns] of Object.entries(ADDED)) {
    const have = new Set(
      (
        db.prepare(`pragma table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name),
    )
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name))
        db.exec(`alter table ${table} add column ${name} ${type}`)
    }
  }
  // indexes on added columns, once they exist
  db.exec('create index if not exists trace_sender on trace(sender)')
}

export function getSync(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, 'select value from sync where key = ?', key)
    ?.value
}

export function setSync(db: Db, key: string, value: string): void {
  db.prepare(
    'insert into sync (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
  ).run(key, value)
}

/** Typed wrappers around node:sqlite, whose rows are untyped records */
export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}

export function one<T>(
  db: Db,
  sql: string,
  ...params: SQLInputValue[]
): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined
}

/**
 * Runs `fn` inside a single sqlite transaction. It takes the write lock up
 * front (waiting for the other process if needed), so `fn` should only
 * write: compute first, then write in here, to keep the lock short.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('begin immediate')
  try {
    const result = fn()
    db.exec('commit')
    return result
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}
