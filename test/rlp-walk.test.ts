import { describe, expect, test } from 'vitest'
import { walkRlp } from '../src/rlp.js'
import { FrameRlpError } from '../src/errors.js'

/**
 * `walkRlp` is the offset-tracking RLP reader `decodeFrameTx` uses instead of
 * viem's `fromRlp`. It exists to do two things `fromRlp` will not: report the
 * byte offset of a malformed body, and reject the non-canonical encodings ethrex
 * rejects at RLP decode rather than silently canonicalising them.
 */
describe('walkRlp: well-formed input', () => {
  test('a single byte below 0x80 stands for itself', () => {
    expect(walkRlp('0x07')).toEqual({ kind: 'string', value: '0x07', start: 0, end: 1 })
  })

  test('the empty string', () => {
    expect(walkRlp('0x80')).toEqual({ kind: 'string', value: '0x', start: 0, end: 1 })
  })

  test('a short string carries its byte range', () => {
    expect(walkRlp('0x821122')).toEqual({
      kind: 'string',
      value: '0x1122',
      start: 0,
      end: 3,
    })
  })

  test('a long string (56 bytes, the short/long boundary)', () => {
    const payload = 'ab'.repeat(56)
    const node = walkRlp(`0xb838${payload}`)
    expect(node).toEqual({ kind: 'string', value: `0x${payload}`, start: 0, end: 58 })
  })

  test('a nested list, with each item positioned', () => {
    // [ 0x01, [ 0x1122 ] ]  ->  c5 01 c3 82 11 22
    const node = walkRlp('0xc501c3821122')
    expect(node.kind).toBe('list')
    if (node.kind !== 'list') throw new Error('unreachable')
    expect(node.items[0]).toEqual({ kind: 'string', value: '0x01', start: 1, end: 2 })
    expect(node.items[1]).toMatchObject({ kind: 'list', start: 2, end: 6 })
    expect(node.end).toBe(6)
  })

  test('the base offset is added to every position', () => {
    // decodeFrameTx passes base 1 so offsets count the 0x06 type byte.
    expect(walkRlp('0x821122', 1)).toMatchObject({ start: 1, end: 4 })
  })
})

describe('walkRlp: malformed input carries an offset', () => {
  const offsetOf = (fn: () => unknown): number | undefined => {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(FrameRlpError)
      return (err as FrameRlpError).offset
    }
    throw new Error('expected walkRlp to throw')
  }

  test('trailing bytes after the item', () => {
    expect(() => walkRlp('0x0700')).toThrow(/trailing byte/)
    expect(offsetOf(() => walkRlp('0x0700'))).toBe(1)
  })

  test('a short string that runs past the end of the buffer', () => {
    expect(() => walkRlp('0x831122')).toThrow(/truncated RLP string/)
    expect(offsetOf(() => walkRlp('0x831122'))).toBe(0)
  })

  test('a list whose payload runs past the end of the buffer', () => {
    expect(() => walkRlp('0xc210')).toThrow(/truncated RLP list/)
    expect(offsetOf(() => walkRlp('0xc210'))).toBe(0)
  })

  test('a nested item names its own offset, not the list head', () => {
    // [ 0x01, <short string claiming 2 bytes, 0 present> ]  ->  c2 01 82
    expect(offsetOf(() => walkRlp('0xc20182'))).toBe(2)
  })
})

describe('walkRlp: non-canonical input is rejected the way ethrex rejects it', () => {
  test('a byte below 0x80 written as a 1-byte string', () => {
    expect(() => walkRlp('0x8107')).toThrow(/non-canonical/)
  })

  test('a length prefix with a leading zero byte', () => {
    // b8 00 ... : long-string length-of-length 1 with a zero length byte
    expect(() => walkRlp(`0xb800${'ab'.repeat(56)}`)).toThrow(/leading zero/)
  })

  test('a 55-byte string in long form (must use the short form)', () => {
    expect(() => walkRlp(`0xb837${'ab'.repeat(55)}`)).toThrow(/must use the short form/)
  })

  test('a short list in long form', () => {
    expect(() => walkRlp('0xf80100')).toThrow(/must use the short form/)
  })
})
