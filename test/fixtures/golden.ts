import type { FrameTransaction } from '../../src/types.js'

/** Two frames — a targetless VERIFY carrying data, then a SENDER frame with a
 *  target — one SECP256K1 signature with an empty msg, no state budget on
 *  either frame. The shape ethrex's `scripts/hegota-testnet/frametx.py` __main__ builds. */
/** EIP-55 form of `0x…abcd`. viem's `getAddress` — and therefore `decodeFrameTx`
 *  and `parseRpcFrameTransaction` — returns checksummed addresses, so the fixture
 *  is written checksummed and `toEqual` against decoder output holds without case
 *  folding. `0x…1234` is all digits and has no checksum case. Encoding is
 *  case-insensitive, so the golden bytes are unaffected. */
const ABCD = '0x000000000000000000000000000000000000ABcD' as const

export const GOLDEN_TX: FrameTransaction = {
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 7n,
  sender: ABCD,
  frames: [
    {
      mode: 1,
      flags: 3,
      target: null,
      limits: { execution: 0x5208n, state: 0n },
      value: 0n,
      data: '0x1122',
    },
    {
      mode: 2,
      flags: 0,
      target: '0x0000000000000000000000000000000000001234',
      limits: { execution: 0x9c40n, state: 0n },
      value: 0n,
      data: '0x',
    },
  ],
  signatures: [
    {
      scheme: 1,
      signer: ABCD,
      msg: '0x',
      signature: `0x${'01'.repeat(65)}`,
    },
  ],
  maxPriorityFeePerGas: 0x3b9aca00n,
  maxFeePerGas: 0x6fc23ac00n,
  maxFeePerBlobGas: 0n,
  blobVersionedHashes: [],
  recentRootReferences: [],
}

/** Copy VERBATIM from frame_tx_wire_tests.rs:67. Do not reflow or re-wrap:
 *  a hand-wrapped transcription of this string was already caught being
 *  10 characters short. */
export const GOLDEN_RLP =
  '0x06f8b301c1800794000000000000000000000000000000000000abcdeccc010380c48252088080821122de0280940000000000000000000000000000000000001234c4829c40808080f85cf85a0194000000000000000000000000000000000000abcd80b8410101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101cc843b9aca008506fc23ac0080c0c0' as const

/** From frame_tx_wire_tests.rs:69. */
export const GOLDEN_SIG_HASH =
  '0xd4df51143828c0338882dbd10c3308f3569972fe1928a7b5040ee18057920510' as const

/** The golden transaction as the node would serve it from
 *  `eth_getTransactionByHash`, minus the block fields. Field names and formats
 *  verified against `transaction.rs:4109-4155` (`FrameTransaction::serialize`)
 *  and `:3755` (`FrameEntry`): the target is `to`, numbers are minimal hex
 *  (`'0x6'`, `'0x0'`), addresses are lowercase. Consumed by Tasks 8 and 11. */
export const GOLDEN_RPC_JSON = {
  type: '0x6',
  chainId: '0x1',
  nonceKeys: ['0x0'],
  nonceSeq: '0x7',
  sender: '0x000000000000000000000000000000000000abcd',
  frames: [
    { mode: '0x1', flags: '0x3', to: null, gasLimit: '0x5208', stateLimit: '0x0',
      value: '0x0', data: '0x1122' },
    { mode: '0x2', flags: '0x0', to: '0x0000000000000000000000000000000000001234',
      gasLimit: '0x9c40', stateLimit: '0x0', value: '0x0', data: '0x' },
  ],
  signatures: [
    { scheme: '0x1', signer: '0x000000000000000000000000000000000000abcd', msg: '0x',
      signature: `0x${'01'.repeat(65)}` },
  ],
  maxPriorityFeePerGas: '0x3b9aca00',
  maxFeePerGas: '0x6fc23ac00',
  maxFeePerBlobGas: '0x0',
  blobVersionedHashes: [],
  recentRootReferences: [],
} as const
