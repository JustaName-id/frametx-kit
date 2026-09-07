import { describe, expect, test } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  SECP256K1_N,
  assertCanonicalSignature,
  assertValidFrameTx,
  recoverFrameSigner,
  resolveSigner,
  signFrameTx,
} from '../src/signatures.js'
import { FrameEncodeError } from '../src/errors.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const PRIVATE_KEY = `0x${'11'.repeat(32)}` as const

describe('assertCanonicalSignature', () => {
  test('rejects a 27/28-encoded v', () => {
    const sig = { scheme: 1 as const, signer: null, msg: '0x' as const,
      signature: `0x1b${'11'.repeat(32)}${'22'.repeat(32)}` as const }
    expect(() => assertCanonicalSignature(sig, 0)).toThrow(/bare recovery id/)
  })

  test('rejects a high s', () => {
    const highS = (SECP256K1_N / 2n + 1n).toString(16).padStart(64, '0')
    const sig = { scheme: 1 as const, signer: null, msg: '0x' as const,
      signature: `0x00${'11'.repeat(32)}${highS}` as const }
    expect(() => assertCanonicalSignature(sig, 0)).toThrow(/must be low/)
  })

  test('rejects a zero r', () => {
    const sig = { scheme: 1 as const, signer: null, msg: '0x' as const,
      signature: `0x00${'00'.repeat(32)}${'22'.repeat(32)}` as const }
    expect(() => assertCanonicalSignature(sig, 0)).toThrow(/r must be/)
  })

  test('rejects the wrong length for secp256k1', () => {
    const sig = { scheme: 1 as const, signer: null, msg: '0x' as const,
      signature: '0x0011' as const }
    expect(() => assertCanonicalSignature(sig, 0)).toThrow(/65 bytes/)
  })

  test('rejects the wrong length for p256', () => {
    const sig = { scheme: 2 as const, signer: null, msg: '0x' as const,
      signature: '0x0011' as const }
    expect(() => assertCanonicalSignature(sig, 0)).toThrow(/128 bytes/)
  })

  test('accepts any bytes for ARBITRARY', () => {
    const sig = { scheme: 0 as const, signer: null, msg: '0x' as const,
      signature: '0xdeadbeef' as const }
    expect(() => assertCanonicalSignature(sig, 0)).not.toThrow()
  })

  test('rejects non-hex characters in secp256k1 signature', () => {
    const sig = { scheme: 1 as const, signer: null, msg: '0x' as const,
      signature: `0x${'zz'.repeat(65)}` as const }
    expect(() => assertCanonicalSignature(sig, 0)).toThrow(FrameEncodeError)
  })
})

describe('resolveSigner', () => {
  test('an empty signer resolves to tx.sender', () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [{ ...GOLDEN_TX.signatures[0]!, signer: null }],
    }
    expect(resolveSigner(tx, 0)).toBe(tx.sender)
  })

  test('an explicit signer is returned as given', () => {
    expect(resolveSigner(GOLDEN_TX, 0)).toBe(GOLDEN_TX.signatures[0]!.signer)
  })
})

describe('signFrameTx and recoverFrameSigner', () => {
  test('a signed transaction recovers to the signing address', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const tx = { ...GOLDEN_TX, sender: account.address,
      signatures: [{ scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const }] }
    const signed = await signFrameTx(tx, PRIVATE_KEY)
    expect(await recoverFrameSigner(signed, 0)).toBe(account.address)
  })

  test('the signature it produces is canonical', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const tx = { ...GOLDEN_TX, sender: account.address,
      signatures: [{ scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const }] }
    const signed = await signFrameTx(tx, PRIVATE_KEY)
    expect(() => assertCanonicalSignature(signed.signatures[0]!, 0)).not.toThrow()
  })

  test('signing is stable under the elision rule', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const tx = { ...GOLDEN_TX, sender: account.address,
      signatures: [{ scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const }] }
    const once = await signFrameTx(tx, PRIVATE_KEY)
    const twice = await signFrameTx(once, PRIVATE_KEY)
    expect(twice.signatures[0]!.signature).toBe(once.signatures[0]!.signature)
  })

  test('signing succeeds when signer explicitly equals the account address', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const tx = { ...GOLDEN_TX, sender: account.address,
      signatures: [{ scheme: 1 as const, signer: account.address, msg: '0x' as const, signature: '0x' as const }] }
    const signed = await signFrameTx(tx, PRIVATE_KEY)
    expect(await recoverFrameSigner(signed, 0)).toBe(account.address)
  })

  test('signing throws FrameEncodeError when signer is a different address', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}` as const).address
    const tx = { ...GOLDEN_TX, sender: account.address,
      signatures: [{ scheme: 1 as const, signer: other, msg: '0x' as const, signature: '0x' as const }] }
    await expect(signFrameTx(tx, PRIVATE_KEY)).rejects.toThrow(FrameEncodeError)
    await expect(signFrameTx(tx, PRIVATE_KEY)).rejects.toThrow(new RegExp(other, 'i'))
  })

  // The guard clauses are inside a function typed `Promise<Address>`. If it is
  // not `async` they throw synchronously and a `.catch()` chain — or these
  // assertions — never see them.
  test('recoverFrameSigner rejects rather than throwing for a missing index', async () => {
    await expect(recoverFrameSigner(GOLDEN_TX, 7)).rejects.toThrow(
      /no signature at index 7/,
    )
  })

  test('recoverFrameSigner rejects rather than throwing for an ARBITRARY entry', async () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [
        { scheme: 0 as const, signer: null, msg: '0x' as const, signature: '0xdeadbeef' as const },
      ],
    }
    await expect(recoverFrameSigner(tx, 0)).rejects.toThrow(/only defined for secp256k1/)
  })

  test('recoverFrameSigner rejects rather than throwing for a non-canonical signature', async () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [
        {
          ...GOLDEN_TX.signatures[0]!,
          signature: `0x1b${'11'.repeat(32)}${'22'.repeat(32)}` as const,
        },
      ],
    }
    await expect(recoverFrameSigner(tx, 0)).rejects.toThrow(/bare recovery id/)
  })

  test('signing throws when signer is null but sender is a different address', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const otherSender = privateKeyToAccount(`0x${'33'.repeat(32)}` as const).address
    const tx = { ...GOLDEN_TX, sender: otherSender,
      signatures: [{ scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const }] }
    await expect(signFrameTx(tx, PRIVATE_KEY)).rejects.toThrow(FrameEncodeError)
  })
})

describe('assertValidFrameTx', () => {
  test('accepts the golden transaction', () => {
    expect(() => assertValidFrameTx(GOLDEN_TX)).not.toThrow()
  })

  test('rejects a structurally invalid transaction', () => {
    const tx = { ...GOLDEN_TX, sender: `0x${'00'.repeat(20)}` as const }
    expect(() => assertValidFrameTx(tx)).toThrow(/zero address/)
  })

  test('rejects a canonically invalid signature (27-encoded v)', () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [
        {
          ...GOLDEN_TX.signatures[0]!,
          signature: `0x1b${'11'.repeat(32)}${'22'.repeat(32)}` as const,
        },
      ],
    }
    expect(() => assertValidFrameTx(tx)).toThrow(/bare recovery id/)
  })

  test('rejects an odd-length data field on a frame', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [{ ...GOLDEN_TX.frames[0]!, data: '0x123' as const }, GOLDEN_TX.frames[1]!],
    }
    expect(() => assertValidFrameTx(tx)).toThrow(FrameEncodeError)
  })

  test('rejects a non-hex data field on a frame', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [{ ...GOLDEN_TX.frames[0]!, data: '0xzz11' as const }, GOLDEN_TX.frames[1]!],
    }
    expect(() => assertValidFrameTx(tx)).toThrow(FrameEncodeError)
  })
})
