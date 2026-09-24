import type { Deposit, Owner } from './types'

/**
 * Who a deposit is attributed to: its owner (src/graph/identity.ts), else
 * who paid for it on the other chain when bridged in, else its depositor.
 * Shared by the API and the UI.
 */
export function senderOf(d: Deposit): string {
  return (
    d.owner?.address ??
    d.bridge?.funder?.address ??
    d.bridge?.depositor ??
    d.depositor
  ).toLowerCase()
}

/** The addresses of a deposit in the order the money came: payer first */
export function addressesOf(d: Deposit): string[] {
  return [
    d.bridge?.funder?.address ?? d.funding?.address,
    d.bridge?.depositor,
    d.depositor,
  ].flatMap((a) => (a ? [a.toLowerCase()] : []))
}

/**
 * Whether a sender is also a recipient: the same address (the sender's own
 * or one of its deposits' addresses), or the same owner
 */
export function sameAs(
  sender: { address: string; addresses?: string[] },
  recipient: string,
  recipientOwner?: Owner,
): 'address' | 'owner' | undefined {
  const r = recipient.toLowerCase()
  if (sender.address === r || (sender.addresses ?? []).includes(r)) {
    return 'address'
  }
  return recipientOwner?.address === sender.address ? 'owner' : undefined
}
