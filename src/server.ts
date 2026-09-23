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

/**
 * Small JSON API over the index. The web UI in `web/` is its only client; in
 * production it is served from `dist/web`, in development Vite proxies /api.
 */
export function serve(db: Db, config: Config): void {
  const app = express()

  app.get('/api/status', (_req, res) => {
    res.json(status(db))
  })

  app.get('/api/search/:query', (req, res) => {
    res.json(resolve(db, req.params.query))
  })

  app.get('/api/address/:address', (req, res) => {
    res.json(addressSummary(db, req.params.address))
  })

  /** the history of one withdrawal (a burn tx hash) as a path */
  app.get('/api/path/:txHash', (req, res) => {
    const burn = getTxn(db, req.params.txHash.toLowerCase().replace(/^0x/, ''))
    if (burn?.kind !== TxKind.Burn) {
      res.status(404).json({ error: 'not a withdrawal' })
      return
    }
    res.json(walkPath(db, burn))
  })

  /** ?tx=<hash>&tx=<hash>&dir=back|forward|both&limit=<n> */
  app.get('/api/graph', (req, res) => {
    const tx = req.query.tx
    const hashes = (Array.isArray(tx) ? tx : [tx])
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase().replace(/^0x/, ''))
    const dir = req.query.dir ?? 'back'
    const limit = Math.min(Number(req.query.limit ?? DEFAULT_LIMIT), 5000)
    res.json(
      graphAround(
        db,
        hashes,
        { backward: dir !== 'forward', forward: dir !== 'back' },
        limit,
      ),
    )
  })

  const web = join(__dirname, '..', 'dist', 'web')
  if (existsSync(web)) {
    app.use(express.static(web))
    app.get('/{*path}', (_req, res) => res.sendFile(join(web, 'index.html')))
  }

  app.listen(config.port, () => {
    log('listening', { port: config.port, web: existsSync(web) })
  })
}
