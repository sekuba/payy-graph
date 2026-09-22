import { existsSync } from 'node:fs'
import { CHAINS, type ChainId, PAYY_NODE_URL } from './protocol'

export interface Config {
  dbPath: string
  payyNodeUrl: string
  rpcUrls: Partial<Record<ChainId, string>>
  port: number
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
  return {
    dbPath: env.PAYY_GRAPH_DB ?? 'data/payy-graph.sqlite',
    payyNodeUrl: env.PAYY_NODE_URL ?? PAYY_NODE_URL,
    rpcUrls,
    port: Number(env.PORT ?? 3020),
  }
}
