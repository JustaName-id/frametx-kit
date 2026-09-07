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
