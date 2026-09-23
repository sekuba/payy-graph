import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import type { Config } from './config'
import type { Db } from './db'
import { getTxn } from './graph/closure'
import { walkPath } from './graph/path'
import {
  addressSummary,
  DEFAULT_LIMIT,
  graphAround,
  resolve,
  status,
} from './graph/queries'
import { log } from './log'
import { TxKind } from './protocol'

/** Largest graph one request may ask for; about half a second of work */
const MAX_LIMIT = 2000
/** Most transactions one graph request may start from */
const MAX_START = 50

/**
 * Small JSON API over the index. The web UI in `web/` is its only client. It
 * is either served from `dist/web` by this server or hosted elsewhere (GitHub
 * Pages), in which case its origin must be set as CORS_ORIGIN.
 *
 * Every query runs synchronously on the one sqlite connection, so a slow
 * request stalls all others. Inputs are capped, and since the history only
 * grows, answers are cached here and may be cached by a CDN in front.
 */
export function serve(db: Db, config: Config): void {
  const app = express()
  app.disable('x-powered-by')
  const cache = new Cache(256 * 1024 * 1024)

  app.use('/api', (_req, res, next) => {
    if (config.corsOrigin) {
      res.set('access-control-allow-origin', config.corsOrigin)
    }
    next()
  })

  /** Answers GET requests from the cache, computing a missing entry */
  const cached =
    (ttlSeconds: number, compute: (req: express.Request) => unknown) =>
    (req: express.Request, res: express.Response) => {
      const body = cache.get(req.originalUrl, ttlSeconds, () =>
        JSON.stringify(compute(req)),
      )
      res.set('cache-control', `public, max-age=${ttlSeconds}`)
      res.type('json').send(body)
    }

  app.get(
    '/api/status',
    cached(30, () => status(db)),
  )

  app.get(
    '/api/search/:query',
    cached(60, (req) => resolve(db, String(req.params.query))),
  )

  app.get(
    '/api/address/:address',
    cached(300, (req) => addressSummary(db, String(req.params.address))),
  )

  /** the history of one withdrawal (a burn tx hash) as a path */
  app.get('/api/path/:txHash', (req, res) => {
    const burn = getTxn(db, hash(req.params.txHash))
    if (burn?.kind !== TxKind.Burn) {
      res.status(404).json({ error: 'not a withdrawal' })
      return
    }
    cached(300, () => walkPath(db, burn))(req, res)
  })

  /** ?tx=<hash>&tx=<hash>&dir=back|forward|both&limit=<n> */
  app.get(
    '/api/graph',
    cached(300, (req) => {
      const tx = req.query.tx
      const hashes = (Array.isArray(tx) ? tx : [tx])
        .filter((h): h is string => typeof h === 'string')
        .slice(0, MAX_START)
        .map(hash)
      const dir = req.query.dir ?? 'back'
      const limit = Number.parseInt(String(req.query.limit), 10)
      return graphAround(
        db,
        hashes,
        { backward: dir !== 'forward', forward: dir !== 'back' },
        limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
      )
    }),
  )

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  const web = join(__dirname, '..', 'dist', 'web')
  if (existsSync(web)) {
    app.use(express.static(web))
    app.get('/{*path}', (_req, res) => res.sendFile(join(web, 'index.html')))
  }

  app.use(
    (
      e: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log('request failed', { error: String(e) })
      res.status(500).json({ error: 'internal error' })
    },
  )

  app.listen(config.port, config.host, () => {
    log('listening', {
      host: config.host,
      port: config.port,
      web: existsSync(web),
      cors: config.corsOrigin ?? 'none',
    })
  })
}

function hash(input: string): string {
  return input.toLowerCase().replace(/^0x/, '')
}

/**
 * Serialized responses by URL. Entries expire after their TTL; beyond `bytes`
 * in total the least recently used ones are dropped.
 */
class Cache {
  private readonly entries = new Map<string, { body: string; at: number }>()
  private total = 0

  constructor(private readonly bytes: number) {}

  get(key: string, ttlSeconds: number, compute: () => string): string {
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.total -= hit.body.length
    }
    const entry =
      hit && Date.now() - hit.at < ttlSeconds * 1000
        ? hit
        : { body: compute(), at: Date.now() }
    this.entries.set(key, entry)
    this.total += entry.body.length
    for (const [oldest, { body }] of this.entries) {
      if (this.total <= this.bytes) break
      this.entries.delete(oldest)
      this.total -= body.length
    }
    return entry.body
  }
}
