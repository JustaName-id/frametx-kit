import { describe, expect, test } from 'vitest'
import { frameTxSigHash } from '../src/sighash.js'
import { GOLDEN_SIG_HASH, GOLDEN_TX } from './fixtures/golden.js'

describe('frameTxSigHash', () => {
  test('reproduces the golden sig hash', () => {
    expect(frameTxSigHash(GOLDEN_TX)).toBe(GOLDEN_SIG_HASH)
  })

  test('is independent of an empty-msg signature\'s bytes', () => {
    const other = {
      ...GOLDEN_TX,
      signatures: [{ ...GOLDEN_TX.signatures[0]!, signature: `0x${'02'.repeat(65)}` as const }],
    }
    expect(frameTxSigHash(other)).toBe(GOLDEN_SIG_HASH)
  })

  test('commits to the bytes of a signature that carries an explicit msg', () => {
    const digest = `0x${'ab'.repeat(32)}` as const
    const withMsg = {
      ...GOLDEN_TX,
      signatures: [{ ...GOLDEN_TX.signatures[0]!, msg: digest }],
    }
    const changed = {
      ...withMsg,
      signatures: [{ ...withMsg.signatures[0]!, signature: `0x${'02'.repeat(65)}` as const }],
    }
    expect(frameTxSigHash(withMsg)).not.toBe(frameTxSigHash(changed))
  })

  test('commits to frame data', () => {
    const changed = {
      ...GOLDEN_TX,
      frames: [{ ...GOLDEN_TX.frames[0]!, data: '0x3344' as const }, GOLDEN_TX.frames[1]!],
    }
    expect(frameTxSigHash(changed)).not.toBe(GOLDEN_SIG_HASH)
  })
})
