import type { Hex } from 'viem'
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
