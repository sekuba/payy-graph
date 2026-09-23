# payy-graph

By [L2BEAT](https://l2beat.com). Everything shown is derived from onchain
state and the public Payy node; nothing is inferred beyond what the data
supports.

Indexes the public spend graph of the [Payy](https://payy.network) network and
shows, for any withdrawal, the deposits that funded it.

## Why this exists

Payy hides the contents of its notes (owner, value) but not the links between
them. Every transaction publishes the commitments of the notes it consumes and
creates, and the deployed circuits have no nullifiers, so `output of tx A ==
input of tx B` is a public edge. Deposits and withdrawals are public on the
settlement chain. Anyone with the block data can therefore walk from a
withdrawal back to the deposits behind it. This package does that walk from
onchain sources only and presents the result without commentary.

The facts it relies on, each verified against onchain state or the Payy
repository, are collected in [`src/protocol.ts`](src/protocol.ts). In short:

- One L2 history since 2025-08-28, settled first on Polygon
  (`0xcd92…76e6`) and since 2026-02-17 on Ethereum (`0x367C…5270`). The
  Polygon root was carried over with `setRoot()`, heights continue and the
  note kind is unchanged, so the graph spans both settlement chains.
- A mint's `mint_hash` matches `MintAdded` on L1; the USDC transfer in the
  same transaction names the depositor. A burn's `burn_hash` is its first
  input commitment and matches `Burned` on L1; the amount and recipient are in
  the proof's public inputs.
- Note values are hidden, but every transaction conserves value and mint and
  burn amounts are public, so amounts along paths without splits or merges
  follow by propagation ([`src/graph/amounts.ts`](src/graph/amounts.ts)).
  Notes that leave a history are followed a short way forward first, so a
  payment withdrawn in full also fixes the change its sender kept.

## What the graph does not walk through

Two kinds of Payy-operated activity would join the histories of unrelated
wallets, so the walk stops at them and shows each as one node
([`src/graph/roles.ts`](src/graph/roles.ts)):

- **The migration distribution.** On 2025-09-12 Payy re-issued the balances
  of its previous chain on this one: from 2.39M USDC of treasury deposits, a
  Payy wallet paid out about 3,000 notes in chains of sends, mostly by 03:00
  UTC the next morning. Every wallet older than that starts its history with
  one of these notes. Which old wallet got which note was decided off-chain,
  so nothing public links a wallet across the migration. (The later move
  from Polygon to Ethereum created no transfers.)
- **Card batches.** A payment with the Payy card is a note sent to Payy's
  collector, which merges the payments two at a time and withdraws each
  batch in one burn to the card settlement contract. Only the batch total is
  public, so a card payment is bounded by its batch (and exact when it is
  alone in it). About 842,000 card payments and as many collector merges
  make up most of the history.

A card payment that repeats on the same day and hour of each month for at
least three months is marked as recurring.

## Where a withdrawal came from

For every withdrawal (except card batches) the sync stores a trace
([`src/graph/traces.ts`](src/graph/traces.ts)): whether its history begins
with a single deposit, the migration, or a merge of two histories; and, over
its backward closure of up to 400 transactions, how many distinct addresses
deposited the funds in it and how many transactions away the nearest deposit
is. The page shown without a query lists the newest activity with these
traces and their medians.

A withdrawal's graph also gives each deposit in it a range: how much of the
withdrawal can have come from it ([`src/graph/sources.ts`](src/graph/sources.ts)).
Funds are fungible within a transaction, but every note caps what passes
through it, and what the other deposits cannot cover must have come from
this one. A wallet that pays 3.06 out of 3.067 keeps 0.007, and whatever it
deposited before can then have contributed at most 0.007 to its later
withdrawals. The parts of the graph that can put less than one cent into
the withdrawal are drawn faint; Payy withdrawals are whole cents. When the
history is larger than the walk, only the lower bounds are given.

## Deposits bridged in from other chains

The Payy app deposits USDC held on other chains through
[Across](https://across.to): the user pays an address the app keeps for them
on that chain, which bridges the funds (swapping USDT to USDC if needed); a
relayer fills them to a fresh address on the settlement chain, which
deposits into Payy seconds later. About a fifth of deposits arrive this way.
The sync traces them back across the bridge ([`src/l1/bridges.ts`](src/l1/bridges.ts)):
when the last USDC transfer into a depositor before its deposit is an Across
fill of exactly the deposited amount, the fill names the origin chain and
the origin address. On the origin chain, the Across deposit is found by its
id, and the transfer that paid the origin address just before it (within an
hour) names who sent the funds. A search for that sender lists the deposit.
Because the app reuses the origin address, it also links all of one user's
bridged deposits. Origin chains need an RPC each (see `.env.example`);
without one, the deposit still shows its origin chain and address.

## Labels and names

Addresses operated by Payy are labelled in `src/protocol.ts`. Other public
labels are generated by `pnpm dev labels` into `src/labels.generated.ts`,
each with its source: Etherscan labels as republished by
[eth-labels](https://github.com/dawsbot/eth-labels) and
[etherscan-labels](https://github.com/brianleect/etherscan-labels), verified
contract names, and exchange deposit addresses (those forwarding what they
receive to a labelled exchange wallet). ENS and GNS
([gwei.domains](https://gwei.domains)) primary names are looked up by the
server, verified both ways, and cached; the browser never asks a third party.

## Layout

```
src/protocol.ts      verified constants: contracts, note kind, event topics
src/payy/            node API client, history indexer, snapshot import/export
src/l1/              minimal JSON-RPC client, event decoding, L1 indexer
src/graph/           closure walk, roles, amount inference, queries, types
src/l1/names.ts      ENS and GNS reverse lookups
src/l1/bridges.ts    deposits bridged in through Across, traced to the origin chain
src/labels.ts        builds src/labels.generated.ts from public sources
src/server.ts        JSON API (express)
src/trace.ts         command line view
src/check.ts         consistency checks
web/                 Vite + React UI: search, layered graph, tables
```

Storage is one SQLite file (`node:sqlite`, no native dependency), one table
per kind of fact: `txn`, `note`, `deposit`, `burned`, `settlement`, and the
derived `role`, `card_batch`, `bridge_in` and `name`.

## Running

Requires Node 22.13 or later (for the built-in SQLite) and pnpm.

```sh
pnpm install
cp .env.example .env        # set ETHEREUM_RPC_URL and POLYGON_RPC_URL
pnpm sync                   # full history, then exits; --follow keeps tailing
pnpm serve                  # API on :3020, serves dist/web when built
pnpm web                    # dev UI on :5173, proxies /api to :3020
pnpm dev:all                # all three above in one terminal (sync --follow, serve, web)
pnpm dev trace <address>    # command line: deposits behind each withdrawal
pnpm dev check              # consistency checks
pnpm dev roles              # classify migration and card batches (sync does this too)
pnpm dev traces             # trace all withdrawals now (sync does it a slice at a time)
pnpm dev names              # resolve ENS and GNS names of all addresses (sync keeps them fresh)
pnpm dev bridges            # trace deposits bridged in from other chains (sync does this too)
pnpm dev labels             # rebuild public labels (needs ETHERSCAN_API_KEY for all of it)
pnpm dev export graph.jsonl # the whole history as public inputs, one tx per line
pnpm dev import graph.jsonl # restore it and continue syncing from there
pnpm check                  # typecheck, lint, tests
```

For production, `pnpm build` writes the server to `dist/` and the UI to
`dist/web/`. `pnpm start` then runs `sync --follow` and `serve` together (the
UI is static files served by `serve`, so no third process); `pnpm start:serve`
runs the server alone if the sync lives elsewhere. The public deployment
(UI on GitHub Pages, API behind a Cloudflare tunnel, systemd units) is
described in [`deploy/README.md`](deploy/README.md).

The first sync downloads about 1.5 million transactions from the public Payy
node at roughly 100 per second; the L1 events take a few minutes over RPC.
Afterwards `sync --follow` tails new blocks.

## Data sources

- Payy node: `https://validators.mainnet.payy.network/v0` (`/transactions`,
  `/blocks`, `/elements`). Timestamps of old blocks are the node's estimates.
- Ethereum and Polygon JSON-RPC: `eth_getLogs` on the Rollup and USDC
  contracts, `eth_getBlockByNumber` for sparse timestamps that events are
  dated by interpolation (seconds on Ethereum, about a minute on Polygon).
- For bridged deposits: the Across fill in the receipt of the transfer that
  funded the depositor, and on the origin chain (Base, Arbitrum, Optimism,
  BNB Chain, or the other settlement chain) the Across deposit and the
  token transfers into the origin address.

The node is operated by Payy and is the only public copy of the history, so
`export` writes the graph to a file that can be kept and shared independently.

## API

```
GET /api/status
GET /api/search/:query          address, Payy tx hash or note commitment
GET /api/address/:address       withdrawals to and deposits from an address
GET /api/path/:burnTx           a withdrawal's history: origin and released notes
GET /api/graph?tx=&dir=back|forward|both&limit=
GET /api/names?a=&a=                ENS and GNS primary names of L1 addresses
GET /api/stats                      live figures: heights, 24h activity, traces
GET /api/live?named=1               newest deposits, withdrawals, card batches
GET /api/named                      labelled and named addresses with totals
```

Amounts are integers in micro USDC. Hashes are hex without `0x`. A graph
request starts from at most 50 transactions and loads at most 2000 (default
400). Responses are cached in memory and carry `cache-control` for a CDN.
