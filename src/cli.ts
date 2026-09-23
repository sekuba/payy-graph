import { check } from './check'
import { loadConfig } from './config'
import { openDb } from './db'
import { deriveRoles } from './graph/roles'
import { deriveTraces } from './graph/traces'
import { syncBridges } from './l1/bridges'
import { syncChain } from './l1/indexer'
import { syncNames } from './l1/names'
import { JsonRpc } from './l1/rpc'
import { buildLabels } from './labels'
import { log } from './log'
import { PayyNode } from './payy/api'
import { syncPayy } from './payy/indexer'
import { exportSnapshot, importSnapshot } from './payy/snapshot'
import { CHAINS } from './protocol'
import { serve } from './server'
import { trace } from './trace'

const USAGE = `payy-graph <command>

  sync [--follow] [--only payy|l1]   index Payy history and L1 events
  serve                              start the API and web UI
  trace <address|hash>               print the deposits behind a withdrawal
  check                              consistency checks of the index
  roles                              classify the migration and card batches
  traces                             trace every withdrawal not traced yet
  names                              resolve ENS and GNS names of all addresses
  bridges                            trace deposits bridged in from other chains
  labels                             rebuild the public address labels
  export <file.jsonl>                write the transaction history snapshot
  import <file.jsonl>                load a snapshot and continue from it
`

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const args = rest.filter((a) => !a.startsWith('--'))
  const option = (name: string) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : undefined
  }

  const config = loadConfig()
  const db = openDb(config.dbPath)

  switch (command) {
    case 'sync': {
      const follow = rest.includes('--follow')
      const only = option('only')
      const jobs: Promise<void>[] = []
      if (only !== 'l1') {
        jobs.push(syncPayy(db, new PayyNode(config.payyNodeUrl), { follow }))
      }
      if (only !== 'payy') {
        for (const chain of Object.values(CHAINS)) {
          const url = config.rpcUrls[chain.id]
          if (!url) {
            log(`skipping ${chain.id}: ${chain.rpcEnv} not set`)
            continue
          }
          jobs.push(syncChain(db, chain, new JsonRpc(url), { follow }))
        }
        const ethereum = config.rpcUrls.ethereum
        if (ethereum)
          jobs.push(syncNames(db, new JsonRpc(ethereum), { follow }))
        jobs.push(bridges(config, db, follow))
      }
      // One source failing should not stop the others; report at the end.
      const results = await Promise.allSettled(jobs)
      for (const r of results) {
        if (r.status === 'rejected') {
          log('sync job failed', { error: String(r.reason) })
          process.exitCode = 1
        }
      }
      break
    }
    case 'serve': {
      serve(db, config)
      break
    }
    case 'trace': {
      if (!args[0]) throw new Error('trace needs an address or hash')
      trace(db, args[0])
      break
    }
    case 'check': {
      check(db)
      break
    }
    case 'roles': {
      deriveRoles(db)
      break
    }
    case 'traces': {
      deriveTraces(db, Number.POSITIVE_INFINITY)
      break
    }
    case 'names': {
      const url = config.rpcUrls.ethereum
      if (!url) throw new Error('names needs ETHEREUM_RPC_URL')
      await syncNames(db, new JsonRpc(url), { follow: false })
      break
    }
    case 'bridges': {
      await bridges(config, db, false)
      break
    }
    case 'labels': {
      await buildLabels(db, config)
      break
    }
    case 'export': {
      if (!args[0]) throw new Error('export needs a file path')
      exportSnapshot(db, args[0])
      break
    }
    case 'import': {
      if (!args[0]) throw new Error('import needs a file path')
      await importSnapshot(db, args[0])
      break
    }
    default:
      process.stdout.write(USAGE)
      process.exitCode = command ? 1 : 0
  }
}

/** Bridged deposits over every configured settlement and origin chain */
function bridges(
  config: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof openDb>,
  follow: boolean,
): Promise<void> {
  const settlement = Object.fromEntries(
    Object.entries(config.rpcUrls).map(([c, url]) => [c, new JsonRpc(url)]),
  )
  const origins = new Map(
    [...config.originRpcUrls].map(([id, url]) => [id, new JsonRpc(url)]),
  )
  return syncBridges(db, settlement, origins, { follow })
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
