import { TOPICS } from '../protocol'
import type { Log } from './rpc'

export interface MintAdded {
  log: Log
  mintHash: string
  amount: number
}

export interface Burned {
  log: Log
  burnHash: string
  recipient: string
  substitute: boolean
  success: boolean
}

export interface RollupVerified {
  log: Log
  height: number
  root: string
}

export interface Transfer {
  log: Log
  from: string
  to: string
  amount: number
}

/** 32-byte word `i` of the data field, hex without 0x */
function word(data: string, i: number): string {
  return data.slice(2 + 64 * i, 2 + 64 * (i + 1))
}

function topicHash(topic: string | undefined): string {
  if (!topic) throw new Error('missing topic')
  return topic.slice(2).toLowerCase()
}

function topicAddress(topic: string | undefined): string {
  return `0x${topicHash(topic).slice(24)}`
}

function toNumber(hexWord: string): number {
  return Number(BigInt(`0x${hexWord}`))
}

export function decodeMintAdded(log: Log): MintAdded {
  return {
    log,
    mintHash: topicHash(log.topics[1]),
    amount: toNumber(word(log.data, 0)),
  }
}

export function decodeBurned(log: Log): Burned {
  return {
    log,
    burnHash: topicHash(log.topics[2]),
    recipient: topicAddress(log.topics[3]),
    substitute: toNumber(word(log.data, 0)) === 1,
    success: toNumber(word(log.data, 1)) === 1,
  }
}

export function decodeRollupVerified(log: Log): RollupVerified {
  return {
    log,
    height: toNumber(topicHash(log.topics[1])),
    root: word(log.data, 0),
  }
}

export function decodeTransfer(log: Log): Transfer {
  return {
    log,
    from: topicAddress(log.topics[1]),
    to: topicAddress(log.topics[2]),
    amount: toNumber(word(log.data, 0)),
  }
}

/** Pads an address to a 32-byte topic */
export function addressTopic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

export const ROLLUP_TOPICS = [
  TOPICS.MintAdded,
  TOPICS.Burned,
  TOPICS.RollupVerified,
]
