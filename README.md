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

## Layout

```
src/protocol.ts      verified constants: contracts, note kind, event topics
src/payy/            node API client, history indexer, snapshot import/export
src/l1/              minimal JSON-RPC client, event decoding, L1 indexer
src/graph/           closure walk, amount inference, queries, shared types
src/server.ts        JSON API (express)
src/trace.ts         command line view
src/check.ts         consistency checks
web/                 Vite + React UI: search, layered graph, tables
```

Storage is one SQLite file (`node:sqlite`, no native dependency), one table
per kind of fact: `txn`, `note`, `deposit`, `burned`, `settlement`.

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
pnpm dev export graph.jsonl # the whole history as public inputs, one tx per line
pnpm dev import graph.jsonl # restore it and continue syncing from there
pnpm check                  # typecheck, lint, tests
```

For production, `pnpm build` writes the server to `dist/` and the UI to
`dist/web/`. `pnpm start` then runs `sync --follow` and `serve` together (the
UI is static files served by `serve`, so no third process); `pnpm start:serve`
runs the server alone if the sync lives elsewhere.

The first sync downloads about 1.5 million transactions from the public Payy
node at roughly 100 per second; the L1 events take a few minutes over RPC.
Afterwards `sync --follow` tails new blocks.

## Data sources

- Payy node: `https://validators.mainnet.payy.network/v0` (`/transactions`,
  `/blocks`, `/elements`). Timestamps of old blocks are the node's estimates.
- Ethereum and Polygon JSON-RPC: `eth_getLogs` on the Rollup and USDC
  contracts, `eth_getBlockByNumber` for sparse timestamps that events are
  dated by interpolation (seconds on Ethereum, about a minute on Polygon).

The node is operated by Payy and is the only public copy of the history, so
`export` writes the graph to a file that can be kept and shared independently.

## API

```
GET /api/status
GET /api/search/:query          address, Payy tx hash or note commitment
GET /api/address/:address       withdrawals to and deposits from an address
GET /api/path/:burnTx           a withdrawal's history: origin and released notes
GET /api/graph?tx=&dir=back|forward|both&limit=
```

Amounts are integers in micro USDC. Hashes are hex without `0x`.
