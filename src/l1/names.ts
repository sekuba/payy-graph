import { all, type Db, transaction } from '../db'
import type { Names } from '../graph/types'
import type { JsonRpc } from './rpc'

/**
 * ENS ReverseRecords: `getNames(address[])` returns each address's primary
 * ENS name, already checked against the name's forward resolution.
 */
const ENS_REVERSE_RECORDS = '0x3671ae578e63fdf66ad4f3e12cc0c0d71ac7510c'
const GET_NAMES = '0xcbf8b66c'
/**
 * GNS (gwei.domains) NameNFT: `reverseResolve(address)` returns the primary
 * .gwei name, only if it resolves back to the address
 * (github.com/lucadonnoh/gwei-names).
 */
const GNS_NAME_NFT = '0x9d51d507bc7264d4fe8ad1cf7fe191933a0a81d6'
const REVERSE_RESOLVE = '0x9af8b7aa'

/** Names change rarely; a checked address is looked up again after a week */
const TTL_SECONDS = 7 * 24 * 3600
const BATCH = 100

interface NameRow {
  address: string
  ens: string | null
  gns: string | null
  checked: number
}

/**
 * Primary names of L1 addresses on Ethereum. Looked up by the server, not
 * the browser, so that which addresses a visitor looks at is not sent to a
 * third-party RPC; cached in the `name` table.
 */
export async function lookupNames(
  db: Db,
  rpc: JsonRpc | undefined,
  addresses: string[],
): Promise<Names> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(
    (a) => /^0x[0-9a-f]{40}$/.test(a),
  )
  const now = Math.floor(Date.now() / 1000)
  const cached = new Map<string, NameRow>()
  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH)
    for (const row of all<NameRow>(
      db,
      `select * from name where address in (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    )) {
      cached.set(row.address, row)
    }
  }
  const stale = wanted.filter(
    (a) => (cached.get(a)?.checked ?? 0) < now - TTL_SECONDS,
  )
  if (rpc && stale.length > 0) {
    const fresh = await resolve(rpc, stale)
    const upsert = db.prepare(
      `insert into name (address, ens, gns, checked) values (?, ?, ?, ?)
       on conflict (address) do update set
         ens = excluded.ens, gns = excluded.gns, checked = excluded.checked`,
    )
    transaction(db, () => {
      for (const [address, n] of fresh) {
        upsert.run(address, n.ens ?? null, n.gns ?? null, now)
        cached.set(address, {
          address,
          ens: n.ens ?? null,
          gns: n.gns ?? null,
          checked: now,
        })
      }
    })
  }
  const names: Names = {}
  for (const a of wanted) {
    const row = cached.get(a)
    if (row?.ens || row?.gns) {
      names[a] = {
        ...(row.ens && { ens: row.ens }),
        ...(row.gns && { gns: row.gns }),
      }
    }
  }
  return names
}

async function resolve(
  rpc: JsonRpc,
  addresses: string[],
): Promise<Map<string, { ens?: string; gns?: string }>> {
  const result = new Map<string, { ens?: string; gns?: string }>()
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH)
    const getNames = (list: string[]) => ({
      to: ENS_REVERSE_RECORDS,
      data: `${GET_NAMES}${word(32)}${word(list.length)}${list.map(pad).join('')}`,
    })
    const [ens, ...gns] = await rpc.ethCalls([
      getNames(chunk),
      ...chunk.map((a) => ({
        to: GNS_NAME_NFT,
        data: REVERSE_RESOLVE + pad(a),
      })),
    ])
    // one broken resolver reverts the whole list; then ask one by one
    const ensNames = ens
      ? decodeStrings(ens)
      : (await rpc.ethCalls(chunk.map((a) => getNames([a])))).map(
          (r) => (r ? decodeStrings(r)[0] : undefined) ?? '',
        )
    chunk.forEach((a, j) => {
      const e = clean(ensNames[j])
      const g = clean(decodeString(gns[j] ?? '0x'))
      result.set(a, { ...(e && { ens: e }), ...(g && { gns: g }) })
    })
  }
  return result
}

/** Names are shown as text; anything odd is dropped rather than displayed */
function clean(name: string | undefined): string | undefined {
  if (!name || name.length > 100) return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined
  return name
}

function word(n: number): string {
  return n.toString(16).padStart(64, '0')
}

function pad(address: string): string {
  return address.slice(2).padStart(64, '0')
}

/** ABI-decodes a returned `string` */
export function decodeString(hex: string): string {
  const data = Buffer.from(hex.slice(2), 'hex')
  if (data.length < 64) return ''
  return readString(data, Number(data.readBigUInt64BE(24)))
}

/** ABI-decodes a returned `string[]` */
export function decodeStrings(hex: string): string[] {
  const data = Buffer.from(hex.slice(2), 'hex')
  if (data.length < 64) return []
  const base = Number(data.readBigUInt64BE(24))
  const n = Number(data.readBigUInt64BE(base + 24))
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const offset = Number(data.readBigUInt64BE(base + 32 + 32 * i + 24))
    out.push(readString(data, base + 32 + offset))
  }
  return out
}

function readString(data: Buffer, at: number): string {
  const length = Number(data.readBigUInt64BE(at + 24))
  return data.subarray(at + 32, at + 32 + length).toString('utf8')
}
