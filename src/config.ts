import { existsSync } from 'node:fs'
import { CHAINS, type ChainId, ORIGIN_CHAINS, PAYY_NODE_URL } from './protocol'

export interface Config {
  dbPath: string
  payyNodeUrl: string
  rpcUrls: Partial<Record<ChainId, string>>
  /** RPCs of the chains deposits are bridged from, by EVM chain id */
  originRpcUrls: Map<number, string>
  host: string
  port: number
  /**
   * The one browser origin allowed to call the API, e.g. the Pages site, or
   * `*`. Sent on every response rather than echoing the request's origin,
   * because a CDN cache does not vary by origin.
   */
  corsOrigin: string | undefined
  /** only for building the public labels (`labels` command) */
  etherscanKey: string | undefined
}

export function loadConfig(): Config {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const env = process.env
  const rpcUrls: Partial<Record<ChainId, string>> = {}
  for (const chain of Object.values(CHAINS)) {
    const url = env[chain.rpcEnv]
    if (url) rpcUrls[chain.id] = url
  }
  const originRpcUrls = new Map<number, string>()
  for (const [id, chain] of Object.entries(ORIGIN_CHAINS)) {
    const url = env[chain.rpcEnv]
    if (url) originRpcUrls.set(Number(id), url)
  }
  return {
    dbPath: env.PAYY_GRAPH_DB ?? 'data/payy-graph.sqlite',
    payyNodeUrl: env.PAYY_NODE_URL ?? PAYY_NODE_URL,
    rpcUrls,
    originRpcUrls,
    // only the tunnel (or a local proxy) should reach the server
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3020),
    corsOrigin: env.CORS_ORIGIN || undefined,
    etherscanKey: env.ETHERSCAN_API_KEY || undefined,
  }
}
