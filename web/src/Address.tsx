import { type ChainId, labelOf, labelSource } from '../../src/protocol'
import { l1AddressUrl, l1TxUrl, shortHex } from './format'
import { nameOf, useNames } from './names'

/**
 * An L1 address as a reader wants to see it: its label if it has one, else
 * its ENS or GNS name, else the shortened hex. The full address and the
 * label's source are in the tooltip. Links to the explorer of `chain`.
 */
export function Address({
  address,
  chain,
  l1Tx,
  full,
  quiet,
  noName,
}: {
  address: string
  chain?: ChainId
  /** link to this L1 transaction instead of the address */
  l1Tx?: string
  /** show the whole hex when there is no label or name */
  full?: boolean
  /** show nothing when there is no label or name */
  quiet?: boolean
  /** leave the name out, where it is shown next to the address */
  noName?: boolean
}) {
  const names = useNames([address])
  const label = labelOf(address)
  const name = noName ? undefined : nameOf(names, address)
  if (quiet && !label && !name) return null
  const text =
    label ??
    name ??
    (full ? (
      <>
        <span className="hidden sm:inline">{address}</span>
        <span className="sm:hidden">{shortHex(address, 6)}</span>
      </>
    ) : (
      shortHex(address, 6)
    ))
  const title = [address, label && `label: ${labelSource(address)}`, name]
    .filter(Boolean)
    .join('\n')
  const className = label ? 'chip' : name ? 'name' : 'mono'
  const href = chain
    ? l1Tx
      ? l1TxUrl(chain, l1Tx)
      : l1AddressUrl(chain, address)
    : undefined
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className}
      title={title}
    >
      {text}
    </a>
  ) : (
    <span className={className} title={title}>
      {text}
    </span>
  )
}

/** The text of an address for places that cannot hold a component (SVG) */
export function useAddressText(addresses: string[]): (a: string) => string {
  const names = useNames(addresses)
  return (a) => labelOf(a) ?? nameOf(names, a) ?? shortHex(a, 6)
}
