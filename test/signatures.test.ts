import { describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
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
import { frameTxSigHash } from '../src/sighash.js'
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

// The account path exists so a key this library never sees — a hardware wallet, a
// KMS, an HD account — can sign. Its bytes must be indistinguishable from the
// private-key path, which the golden sig-hash and oracle 3 already pin.
describe('signFrameTx with an account', () => {
  const oneEmptyEntry = (sender: Address) => ({
    ...GOLDEN_TX,
    sender,
    signatures: [
      { scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const },
    ],
  })

  test('signs with a viem account and recovers to its address', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const signed = await signFrameTx(oneEmptyEntry(account.address), account)
    expect(await recoverFrameSigner(signed, 0)).toBe(account.address)
  })

  test('produces the same bytes as the private-key path', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const tx = oneEmptyEntry(account.address)
    const viaKey = await signFrameTx(tx, PRIVATE_KEY)
    const viaAccount = await signFrameTx(tx, account)
    expect(viaAccount.signatures[0]!.signature).toBe(viaKey.signatures[0]!.signature)
  })

  // What a KMS or hardware wrapper looks like: an address and a raw-digest signer,
  // with none of viem's other account surface.
  test('signs with a bare { address, sign } remote signer', async () => {
    const inner = privateKeyToAccount(PRIVATE_KEY)
    const remote = {
      address: inner.address,
      sign: ({ hash }: { hash: Hex }) => inner.sign({ hash }),
    }
    const signed = await signFrameTx(oneEmptyEntry(inner.address), remote)
    expect(await recoverFrameSigner(signed, 0)).toBe(inner.address)
  })

  test('signs over the transaction sig-hash, not some other digest', async () => {
    const inner = privateKeyToAccount(PRIVATE_KEY)
    const seen: Hex[] = []
    const remote = {
      address: inner.address,
      sign: ({ hash }: { hash: Hex }) => {
        seen.push(hash)
        return inner.sign({ hash })
      },
    }
    const tx = oneEmptyEntry(inner.address)
    await signFrameTx(tx, remote)
    expect(seen).toEqual([frameTxSigHash(tx)])
  })

  // A JsonRpcAccount has no signing methods, and `signMessage` is not a substitute:
  // it EIP-191-prefixes the digest, so the signature would recover to nothing.
  test('rejects an account that cannot sign a raw digest', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const jsonRpc = { address: account.address, type: 'json-rpc' as const }
    await expect(signFrameTx(oneEmptyEntry(account.address), jsonRpc)).rejects.toThrow(
      FrameEncodeError,
    )
    await expect(signFrameTx(oneEmptyEntry(account.address), jsonRpc)).rejects.toThrow(
      /raw 32-byte digest/,
    )
  })

  test('rejects an account whose address is not the resolved signer', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}` as const).address
    const tx = { ...GOLDEN_TX, sender: account.address,
      signatures: [{ scheme: 1 as const, signer: other, msg: '0x' as const, signature: '0x' as const }] }
    await expect(signFrameTx(tx, account)).rejects.toThrow(new RegExp(other, 'i'))
  })

  test('leaves a P256 entry untouched', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const p256 = {
      scheme: 2 as const,
      signer: null,
      msg: '0x' as const,
      signature: `0x${'11'.repeat(128)}` as const,
    }
    const tx = { ...GOLDEN_TX, sender: account.address, signatures: [p256] }
    const signed = await signFrameTx(tx, account)
    expect(signed.signatures[0]).toEqual(p256)
  })
})

// Only the account path can reach these: `privateKeyToAccount` always returns
// viem's 27/28, but an HSM or a hand-rolled wrapper may hand back a bare
// recovery id. Getting this wrong writes a malformed `v` byte into a signature
// the chain rejects at consensus, so it is checked rather than assumed.
describe('signFrameTx recovery-id normalization', () => {
  const signerReturning = (address: Address, vByte: string, flat: Hex) => ({
    address,
    sign: async () => `0x${flat.slice(2, 130)}${vByte}` as Hex,
  })

  test('accepts a signer that returns a bare recovery id', async () => {
    const inner = privateKeyToAccount(PRIVATE_KEY)
    const tx = {
      ...GOLDEN_TX,
      sender: inner.address,
      signatures: [
        { scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const },
      ],
    }
    const flat = await inner.sign({ hash: frameTxSigHash(tx) })
    const v27 = BigInt(`0x${flat.slice(130)}`)
    const bare = (v27 - 27n).toString(16).padStart(2, '0')

    const viaBare = await signFrameTx(tx, signerReturning(inner.address, bare, flat))
    const viaPrefixed = await signFrameTx(tx, inner)
    expect(viaBare.signatures[0]!.signature).toBe(viaPrefixed.signatures[0]!.signature)
  })

  test('rejects a signer that returns an EIP-155 v', async () => {
    const inner = privateKeyToAccount(PRIVATE_KEY)
    const tx = {
      ...GOLDEN_TX,
      sender: inner.address,
      signatures: [
        { scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const },
      ],
    }
    const flat = await inner.sign({ hash: frameTxSigHash(tx) })
    await expect(
      signFrameTx(tx, signerReturning(inner.address, '25', flat)),
    ).rejects.toThrow(/signer returned v=37/)
  })
})
