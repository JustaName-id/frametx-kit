import { describe, expect, test } from 'vitest'
import { decodeFrameTx, encodeFrameTx } from '../src/envelope.js'
import { FrameDecodeError } from '../src/errors.js'
import { GOLDEN_RLP, GOLDEN_TX } from './fixtures/golden.js'

describe('decodeFrameTx', () => {
  test('decodes the golden vector to the golden transaction', () => {
    expect(decodeFrameTx(GOLDEN_RLP)).toEqual(GOLDEN_TX)
  })

  test('round-trips the golden vector', () => {
    expect(encodeFrameTx(decodeFrameTx(GOLDEN_RLP))).toBe(GOLDEN_RLP)
  })

  test('rejects a non-0x06 type byte', () => {
    expect(() => decodeFrameTx('0x02c0')).toThrow(FrameDecodeError)
  })

  test('rejects a body that is not a list', () => {
    expect(() => decodeFrameTx('0x0680')).toThrow(FrameDecodeError)
  })

  test('rejects a body with the wrong field count', () => {
    expect(() => decodeFrameTx('0x06c20180')).toThrow(FrameDecodeError)
  })
})

describe('decodeFrameTx: non-canonical RLP', () => {
  // `nonceSeq` is 7, canonically the single byte 0x07. Written long-form as
  // 0x81 0x07 it is one byte longer, so the outer list header grows from
  // 0xf8 0xb3 to 0xf8 0xb4. viem's `fromRlp` accepts the long form and returns
  // 7; ethrex's decoder rejects it ("the 0x81 0x01 form is now rejected"), so
  // decoding it here would hand back a transaction whose bytes the chain will
  // not take.
  const LONG_FORM_NONCE_SEQ = GOLDEN_RLP.replace('c18007', 'c1808107').replace(
    '0x06f8b3',
    '0x06f8b4',
  )

  test('the mutation is a real one', () => {
    expect(LONG_FORM_NONCE_SEQ).not.toBe(GOLDEN_RLP)
    expect(LONG_FORM_NONCE_SEQ.length).toBe(GOLDEN_RLP.length + 2)
  })

  test('rejects a long-form encoding of a single-byte scalar', () => {
    expect(() => decodeFrameTx(LONG_FORM_NONCE_SEQ as `0x${string}`)).toThrow(
      FrameDecodeError,
    )
    expect(() => decodeFrameTx(LONG_FORM_NONCE_SEQ as `0x${string}`)).toThrow(
      /non-canonical/,
    )
  })

  test('rejects a non-minimal scalar (leading zero byte) as a decode error', () => {
    // nonceSeq 7 written as the two-byte string 0x00 0x07: `82 00 07` replaces
    // `07`, and the outer list grows by two. viem returns the bytes verbatim,
    // `parseRlpUint` rejects the leading zero, and the caller must see that as
    // a FrameDecodeError like every other malformed-body case, not the internal
    // FrameRlpError.
    const leadingZero = GOLDEN_RLP.replace('c18007', 'c180820007').replace(
      '0x06f8b3',
      '0x06f8b5',
    ) as `0x${string}`
    expect(leadingZero.length).toBe(GOLDEN_RLP.length + 4)
    expect(() => decodeFrameTx(leadingZero)).toThrow(FrameDecodeError)
    expect(() => decodeFrameTx(leadingZero)).toThrow(/non-minimal/)
  })

  test('accepts uppercase hex, which is the same bytes', () => {
    const upper = `0x06${GOLDEN_RLP.slice(4).toUpperCase()}` as const
    expect(decodeFrameTx(upper)).toEqual(GOLDEN_TX)
  })
})
