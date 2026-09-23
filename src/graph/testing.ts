/** Builders for small synthetic histories in tests */

import { parseTxn } from '../payy/indexer'
import { NOTE_KIND_USDC, ZERO_COMMITMENT as ZERO } from '../protocol'

const word = (n: number) => n.toString(16).padStart(64, '0')

/** an L1 address as the 32-byte burn recipient word */
export const addr = (n: number | string) =>
  typeof n === 'string'
    ? `${'0'.repeat(24)}${n.slice(2)}`
    : `${'0'.repeat(24)}${n.toString(16).padStart(40, '0')}`

/** A transaction at `height` (its time is the height too) */
export function txn(
  hash: string,
  height: number,
  kind: number,
  inputs: string[],
  outputs: string[],
  amount = 0,
  extra = ZERO,
) {
  return parseTxn({
    hash,
    block_height: height,
    index_in_block: 0,
    time: height,
    public_inputs: {
      input_commitments: [inputs[0] ?? ZERO, inputs[1] ?? ZERO],
      output_commitments: [outputs[0] ?? ZERO, outputs[1] ?? ZERO],
      messages: [
        word(kind),
        kind === 1 ? ZERO : NOTE_KIND_USDC,
        word(amount),
        kind === 2 ? 'mh' : (inputs[0] ?? ZERO),
        extra,
      ],
    },
  })
}
