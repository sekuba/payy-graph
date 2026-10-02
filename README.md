# payy-graph

The public spend graph of [Payy](https://payy.network): for any withdrawal,
the deposits that funded it. <https://sekuba.github.io/payy-graph/>

## Running

Node 22.13 or later and pnpm.

```sh
pnpm install
cp .env.example .env    # ETHEREUM_RPC_URL, POLYGON_RPC_URL; the rest optional
pnpm sync               # full history, a few hours the first time; --follow keeps tailing
pnpm serve              # API on :3020
pnpm web                # UI on :5173
pnpm check              # typecheck, lint, tests
```

`pnpm dev` lists the other commands. Deployment:
[`deploy/README.md`](deploy/README.md).
