import { describe, expect, test } from 'vitest'
import { encodeFrameTx } from '../src/envelope.js'
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
})
