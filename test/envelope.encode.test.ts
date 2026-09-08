import { describe, expect, test } from 'vitest'
import { decodeFrameTx, encodeFrameTx, encodeFrameTxBody } from '../src/envelope.js'
import { GOLDEN_RLP, GOLDEN_TX } from './fixtures/golden.js'

describe('encodeFrameTx', () => {
  test('reproduces the golden vector byte-for-byte', () => {
    expect(encodeFrameTx(GOLDEN_TX)).toBe(GOLDEN_RLP)
  })

  test('encodes nonceSeq zero as empty string, not 0x00', () => {
    const encoded = encodeFrameTx({ ...GOLDEN_TX, nonceSeq: 0n })
    expect(encoded).not.toBe(GOLDEN_RLP)
    // nonceSeq: 7 encodes as 07, nonceSeq: 0 encodes as 80 (empty string in RLP)
    // Sequence c180 (nonceKeys) should be followed by 80 (nonceSeq zero)
    // then 94 (sender), instead of 07
    expect(encoded).toContain('c1808094')
  })

  test('a targetless frame encodes an empty target, not 20 zero bytes', () => {
    const encoded = encodeFrameTx(GOLDEN_TX)
    // frame 1 is `cc 01 03 80 c4825208 80 80 821122`: mode, flags, empty target
    expect(encoded).toContain('cc010380c4825208')
  })

  test('encodeFrameTxBody is the wire encoding minus the 0x06 type byte', () => {
    expect(encodeFrameTx(GOLDEN_TX)).toBe(`0x06${encodeFrameTxBody(GOLDEN_TX).slice(2)}`)
  })

  test('limits always encode as a two-element list, even when state is zero', () => {
    // frame 1 limits are { execution: 0x5208, state: 0 } -> c4 (825208)(80)
    expect(encodeFrameTx(GOLDEN_TX)).toContain('c482520880')
  })

  test('the fees list always has three entries, even when maxFeePerBlobGas is zero', () => {
    // cc (843b9aca00)(8506fc23ac00)(80) — the trailing 80 is the zero blob fee
    expect(encodeFrameTx(GOLDEN_TX)).toContain('cc843b9aca008506fc23ac0080')
  })

  test('an empty blob list and an empty reference list each encode as 0xc0', () => {
    expect(encodeFrameTx(GOLDEN_TX).endsWith('c0c0')).toBe(true)
  })
})

// Scheme 2 has no captured fixture and no golden vector, so its wire shape is
// otherwise unpinned. A 128-byte signature crosses the RLP short/long-string
// boundary (>55 bytes), so it must encode as `b8 80 <128 bytes>`.
describe('encodeFrameTx: P256 signature entry', () => {
  const p256Tx = {
    ...GOLDEN_TX,
    signatures: [
      {
        scheme: 2 as const,
        signer: null,
        msg: '0x' as const,
        signature: `0x${'2b'.repeat(128)}` as const,
      },
    ],
  }

  test('a 128-byte signature encodes as an RLP long string, b8 80 ...', () => {
    expect(encodeFrameTx(p256Tx)).toContain(`b880${'2b'.repeat(128)}`)
  })

  test('the scheme byte is 02 and the signer is the empty string', () => {
    // signature entry: <list> 02 80 80 b880<128>  (scheme, empty signer, empty msg)
    expect(encodeFrameTx(p256Tx)).toContain(`028080b880${'2b'.repeat(128)}`)
  })

  test('round-trips through decodeFrameTx', () => {
    expect(decodeFrameTx(encodeFrameTx(p256Tx))).toEqual(p256Tx)
  })
})
