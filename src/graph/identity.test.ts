import { expect } from 'earl'
import { groupIdentities } from './identity'

describe(groupIdentities.name, () => {
  it('joins bridge addresses by events and a payer by payment', () => {
    const g = groupIdentities(
      [
        // deposit address on Ethereum, origin address on Base
        { a: '0xdep', b: '0xorigin', paid: false },
        // the owner's wallet paid the origin address
        { a: '0xwallet', b: '0xorigin', paid: true },
        // another user, linked by events only
        { a: '0xdep2', b: '0xorigin2', paid: false },
      ],
      () => false,
    )
    // shown by the payer, the owner's own wallet
    expect(g.get('0xdep')).toEqual({ root: '0xwallet', size: 3, paid: true })
    expect(g.get('0xdep2')).toEqual({ root: '0xdep2', size: 2, paid: false })
  })

  it('prefers a named address as the root', () => {
    const g = groupIdentities(
      [{ a: '0xa', b: '0xb', paid: false }],
      (x) => x === '0xb',
    )
    expect(g.get('0xa')?.root).toEqual('0xb')
  })
})
