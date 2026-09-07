import { describe, expect, test } from 'vitest'
import { byteLength, parseRlpUint, rlpUint } from '../src/rlp.js'
import { FrameRlpError } from '../src/errors.js'

describe('rlpUint', () => {
  test('zero is the empty string, not 0x00', () => {
    expect(rlpUint(0n)).toBe('0x')
  })

  test('single low byte is one byte, not odd-length hex', () => {
    expect(rlpUint(7n)).toBe('0x07')
  })

  test('pads to even length', () => {
    expect(rlpUint(0xabcn)).toBe('0x0abc')
  })

  test('strips no significant bytes', () => {
    expect(rlpUint(0x3b9aca00n)).toBe('0x3b9aca00')
    expect(rlpUint(0x6fc23ac00n)).toBe('0x06fc23ac00')
  })

  test('rejects negatives', () => {
    expect(() => rlpUint(-1n)).toThrow(FrameRlpError)
  })
})

describe('parseRlpUint', () => {
  test('empty string is zero', () => {
    expect(parseRlpUint('0x')).toBe(0n)
  })

  test('round-trips', () => {
    for (const v of [0n, 1n, 7n, 255n, 256n, 0x6fc23ac00n, 2n ** 255n]) {
      expect(parseRlpUint(rlpUint(v))).toBe(v)
    }
  })

  test('rejects a non-minimal encoding', () => {
    expect(() => parseRlpUint('0x00')).toThrow(FrameRlpError)
    expect(() => parseRlpUint('0x0007')).toThrow(FrameRlpError)
  })
})

describe('byteLength', () => {
  test('counts bytes, not hex characters', () => {
    expect(byteLength('0x')).toBe(0)
    expect(byteLength('0x1122')).toBe(2)
  })

  test('rejects odd-length hex', () => {
    expect(() => byteLength('0x123')).toThrow(FrameRlpError)
  })

  test('rejects non-hex characters', () => {
    expect(() => byteLength('0xzz')).toThrow(FrameRlpError)
    expect(() => byteLength('0x11zz22')).toThrow(FrameRlpError)
  })
})

describe('parseRlpUint additional', () => {
  test('rejects odd-length input', () => {
    expect(() => parseRlpUint('0x7')).toThrow(FrameRlpError)
    expect(() => parseRlpUint('0xabc')).toThrow(FrameRlpError)
  })

  test('rejects non-hex characters', () => {
    expect(() => parseRlpUint('0xzz')).toThrow(FrameRlpError)
    expect(() => parseRlpUint('0xaabbzz')).toThrow(FrameRlpError)
  })
})
