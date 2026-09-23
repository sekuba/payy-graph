import { useEffect, useSyncExternalStore } from 'react'
import type { Names } from '../../src/graph/types'
import { api } from './api'

/**
 * ENS and GNS names of the addresses on screen. Components ask for the
 * addresses they show; requests are batched and every answer is kept for
 * the session, so each address is looked up once.
 */
const known: Names = {}
const asked = new Set<string>()
const waiting = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let timer: ReturnType<typeof setTimeout> | undefined

function request(addresses: string[]) {
  for (const a of addresses) {
    const key = a.toLowerCase()
    if (!asked.has(key)) {
      asked.add(key)
      waiting.add(key)
    }
  }
  if (waiting.size > 0 && !timer) timer = setTimeout(flush, 50)
}

async function flush() {
  timer = undefined
  const batch = [...waiting].slice(0, 200)
  for (const a of batch) waiting.delete(a)
  if (waiting.size > 0) timer = setTimeout(flush, 50)
  try {
    Object.assign(known, await api.names(batch))
    version++
    for (const l of listeners) l()
  } catch {
    // names are an extra; without them addresses show as hex
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Adds names the server sent along with other data */
export function seedNames(names: Names) {
  for (const a of Object.keys(names)) asked.add(a)
  Object.assign(known, names)
  version++
  for (const l of listeners) l()
}

/** The names known so far; asks for the given addresses in the background */
export function useNames(addresses: string[]): Names {
  const key = addresses.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content
  useEffect(() => request(addresses), [key])
  useSyncExternalStore(subscribe, () => version)
  return known
}

/** The name to show for an address: ENS first, then GNS */
export function nameOf(names: Names, address: string): string | undefined {
  const n = names[address.toLowerCase()]
  return n?.ens ?? n?.gns
}
