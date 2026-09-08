import { type Hex, bytesToHex, hexToBytes } from 'viem'
import { FrameRlpError } from './errors.js'

/**
 * An RLP integer scalar: minimal big-endian with no leading zero byte, and zero
 * encoded as the empty string.
 *
 * Do NOT substitute viem's `numberToHex`, which returns '0x0' for zero and
 * odd-length hex for small values. Neither is byte-aligned RLP.
 */
export function rlpUint(value: bigint): Hex {
  if (value < 0n) throw new FrameRlpError(`RLP scalars are unsigned, got ${value}`)
  if (value === 0n) return '0x'
  const hex = value.toString(16)
  return `0x${hex.length % 2 === 1 ? `0${hex}` : hex}`
}

/** Inverse of `rlpUint`, rejecting a non-minimal encoding, odd-length, and non-hex input. */
export function parseRlpUint(value: Hex): bigint {
  if (value === '0x') return 0n
  const body = value.slice(2)
  if (body.length % 2 === 1)
    throw new FrameRlpError(`hex string is not byte-aligned: ${value}`)
  if (!/^[0-9a-fA-F]*$/.test(body))
    throw new FrameRlpError(`hex string contains non-hex characters: ${value}`)
  if (value.startsWith('0x00'))
    throw new FrameRlpError(`non-minimal RLP scalar: ${value}`)
  return BigInt(value)
}

/** Byte length of a hex string, rejecting odd-length input and non-hex characters. */
export function byteLength(value: Hex): number {
  const body = value.slice(2)
  if (body.length % 2 === 1)
    throw new FrameRlpError(`hex string is not byte-aligned: ${value}`)
  if (!/^[0-9a-fA-F]*$/.test(body))
    throw new FrameRlpError(`hex string contains non-hex characters: ${value}`)
  return body.length / 2
}

/**
 * One node of a parsed RLP tree, with the byte range it occupied in the input.
 *
 * `start` is the offset of the node's first prefix byte and `end` is one past
 * its last byte, both measured with whatever `base` was passed to `walkRlp` —
 * `decodeFrameTx` passes 1, so offsets count the `0x06` type byte as byte 0 and
 * a `FrameDecodeError` can point straight at the hex the caller passed in.
 */
export type RlpNode =
  | { readonly kind: 'string'; readonly value: Hex; readonly start: number; readonly end: number }
  | { readonly kind: 'list'; readonly items: readonly RlpNode[]; readonly start: number; readonly end: number }

/** Big-endian bytes to a JS number. Only ever called on an RLP length prefix. */
function beToNumber(bytes: Uint8Array): number {
  let n = 0
  for (const byte of bytes) n = n * 256 + byte
  return n
}

/**
 * Matches the `rlpDepthLimit` viem's `fromRlp` enforced (1024). A frame
 * transaction nests about four lists deep, so this only ever fires on
 * pathological input — where it turns a `RangeError` from stack exhaustion into
 * a typed `FrameRlpError` the caller can catch.
 */
const MAX_RLP_DEPTH = 1024

/**
 * Parse one complete RLP item and require it to consume the whole input.
 *
 * Written by hand rather than delegating to viem's `fromRlp` for two reasons the
 * survey needs: `fromRlp` reports no offset when it rejects a malformed body, and
 * it silently canonicalises non-canonical input (a single byte written as an
 * `0x81` string, a length prefix with a leading zero, a short payload in long
 * form) that ethrex rejects at RLP decode. This reader rejects the same bytes
 * ethrex does and names the offset it found them at.
 *
 * It does not enforce the *scalar* rule that an integer field carry no leading
 * zero byte — that is `parseRlpUint`'s job, applied per field, because it is a
 * fact about what a field means and not about whether the bytes are well formed.
 */
export function walkRlp(value: Hex, base = 0): RlpNode {
  // viem's `hexToBytes` does not reject a non-byte-aligned string — it prepends
  // a zero nibble, which shifts every byte and so every offset this reader would
  // report. `fromRlp` rejected it; keep rejecting it.
  if (value.length % 2 !== 0)
    throw new FrameRlpError(`hex string is not byte-aligned: ${value}`, base)
  let bytes: Uint8Array
  try {
    bytes = hexToBytes(value)
  } catch (cause) {
    throw new FrameRlpError(`not a hex string: ${(cause as Error).message}`, base)
  }
  const node = readItem(bytes, 0, base, 0)
  if (node.end - base !== bytes.length)
    throw new FrameRlpError(
      `${bytes.length - (node.end - base)} trailing byte(s) after the RLP item`,
      node.end,
    )
  return node
}

function readItem(bytes: Uint8Array, pos: number, base: number, depth: number): RlpNode {
  const at = pos + base
  if (depth > MAX_RLP_DEPTH)
    throw new FrameRlpError(`RLP nested deeper than ${MAX_RLP_DEPTH}`, at)
  if (pos >= bytes.length)
    throw new FrameRlpError(`truncated RLP: expected an item`, at)
  const prefix = bytes[pos]!

  // A single byte below 0x80 stands for itself.
  if (prefix <= 0x7f)
    return { kind: 'string', value: bytesToHex(bytes.subarray(pos, pos + 1)), start: at, end: at + 1 }

  // Short string: 0..55 bytes.
  if (prefix <= 0xb7) {
    const len = prefix - 0x80
    const dataStart = pos + 1
    const dataEnd = dataStart + len
    if (dataEnd > bytes.length)
      throw new FrameRlpError(
        `truncated RLP string: header declares ${len} byte(s), ${bytes.length - dataStart} present`,
        at,
      )
    if (len === 1 && bytes[dataStart]! <= 0x7f)
      throw new FrameRlpError(
        `non-canonical RLP: a byte below 0x80 must be encoded as itself, not as a 1-byte string`,
        at,
      )
    return { kind: 'string', value: bytesToHex(bytes.subarray(dataStart, dataEnd)), start: at, end: dataEnd + base }
  }

  // Long string: length-of-length then the payload.
  if (prefix <= 0xbf) {
    const lenOfLen = prefix - 0xb7
    const { len, dataStart } = readLongLength(bytes, pos, lenOfLen, base, 'string')
    const dataEnd = dataStart + len
    if (dataEnd > bytes.length)
      throw new FrameRlpError(
        `truncated RLP string: header declares ${len} byte(s), ${bytes.length - dataStart} present`,
        at,
      )
    return { kind: 'string', value: bytesToHex(bytes.subarray(dataStart, dataEnd)), start: at, end: dataEnd + base }
  }

  // Short list.
  if (prefix <= 0xf7) return readList(bytes, pos, pos + 1, prefix - 0xc0, base, depth)

  // Long list.
  const lenOfLen = prefix - 0xf7
  const { len, dataStart } = readLongLength(bytes, pos, lenOfLen, base, 'list')
  return readList(bytes, pos, dataStart, len, base, depth)
}

function readLongLength(
  bytes: Uint8Array,
  pos: number,
  lenOfLen: number,
  base: number,
  what: 'string' | 'list',
): { len: number; dataStart: number } {
  const at = pos + base
  const lenStart = pos + 1
  if (lenStart + lenOfLen > bytes.length)
    throw new FrameRlpError(`truncated RLP ${what} length prefix`, at)
  if (bytes[lenStart] === 0)
    throw new FrameRlpError(`non-canonical RLP: leading zero byte in a length prefix`, at)
  const len = beToNumber(bytes.subarray(lenStart, lenStart + lenOfLen))
  if (len < 56)
    throw new FrameRlpError(
      `non-canonical RLP: a ${len}-byte ${what} must use the short form`,
      at,
    )
  return { len, dataStart: lenStart + lenOfLen }
}

function readList(
  bytes: Uint8Array,
  pos: number,
  payloadStart: number,
  payloadLen: number,
  base: number,
  depth: number,
): RlpNode {
  const at = pos + base
  const payloadEnd = payloadStart + payloadLen
  if (payloadEnd > bytes.length)
    throw new FrameRlpError(
      `truncated RLP list: header declares ${payloadLen} payload byte(s), ${bytes.length - payloadStart} present`,
      at,
    )
  const items: RlpNode[] = []
  let cursor = payloadStart
  while (cursor < payloadEnd) {
    const item = readItem(bytes, cursor, base, depth + 1)
    if (item.end - base > payloadEnd)
      throw new FrameRlpError(
        `RLP item overruns its parent list, whose payload ends at byte ${payloadEnd + base}`,
        item.start,
      )
    items.push(item)
    cursor = item.end - base
  }
  return { kind: 'list', items, start: at, end: payloadEnd + base }
}
