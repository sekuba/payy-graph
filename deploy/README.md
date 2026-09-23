# Deployment

The UI is static and lives on GitHub Pages. The API and the indexer run on one
machine next to the SQLite file and are reached through a Cloudflare tunnel.

```
<owner>.github.io/<repo>/  GitHub Pages     dist/web, built by .github/workflows/pages.yml
alsonot.slashveto.me       cloudflared  ->  127.0.0.1:3020  (payy-graph-serve)
                                            payy-graph-sync writes the same SQLite file
```

## Services

Sync and serve are separate units so that the sync failing (the Payy node or
an RPC being down) restarts only the sync and the API stays up.

```sh
pnpm install && pnpm build
cp deploy/payy-graph-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now payy-graph-sync payy-graph-serve
sudo loginctl enable-linger $USER   # keep them running without a login session
journalctl --user -u payy-graph-serve -f
```

`.env` needs, besides the RPC urls:

```
HOST=127.0.0.1
PORT=3020
CORS_ORIGIN=https://<owner>.github.io
```

The CORS origin is the scheme and host of the Pages site, without the
`/<repo>` path.

After pulling changes: `pnpm build && systemctl --user restart payy-graph-sync payy-graph-serve`.

## Cloudflare

- Tunnel public hostname `alsonot.slashveto.me` to `http://127.0.0.1:3020`.
- Cache rule: hostname equals `alsonot.slashveto.me` → eligible for cache,
  edge TTL "use cache-control header if present". The API sends `max-age` of
  30 s (status) to 300 s (graphs, paths).
- Rate limiting rule on the same hostname, per IP, e.g. 60 requests per 10 s.
  Every uncached request runs on the single SQLite connection.

## GitHub Pages

- Settings → Pages → Source: GitHub Actions. The workflow builds on every
  push to `main`.
- The UI calls `https://alsonot.slashveto.me` unless the repository variable
  `API_URL` says otherwise.
