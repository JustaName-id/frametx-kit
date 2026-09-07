import { type Address, type Hex, recoverAddress, sliceHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { validateFrameTx } from './envelope.js'
import { FrameEncodeError, FrameRlpError } from './errors.js'
import { byteLength } from './rlp.js'
import { frameTxSigHash } from './sighash.js'
import type { FrameSignature, FrameTransaction } from './types.js'

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const SECP256R1_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/**
 * Get byte length, converting RLP validation errors to encode errors.
 */
function signatureByteLength(sig: Hex, index: number): number {
  try {
    return byteLength(sig)
  } catch (err) {
    if (err instanceof FrameRlpError)
      throw new FrameEncodeError(`signature ${index}: ${err.message}`)
    throw err
  }
}

/**
 * EIP-8141 canonicality, checked at consensus in `validate_frame_signatures`
 * before any frame executes — a violation invalidates the whole transaction.
 *
 * Layout note: the field is `v || r || s`, with `v` at byte 0. That is the
 * REVERSE of Ethereum's usual `r || s || v`, and of what viem's
 * `signatureToHex` produces.
 */
export function assertCanonicalSignature(sig: FrameSignature, index: number): void {
  if (sig.scheme === 0) return // ARBITRARY carries no ECDSA scalars

  if (sig.scheme === 1) {
    const len = signatureByteLength(sig.signature, index)
    if (len !== 65)
      throw new FrameEncodeError(
        `signature ${index}: secp256k1 must be 65 bytes (v||r||s), got ${len}`,
      )
    const v = BigInt(sliceHex(sig.signature, 0, 1))
    const r = BigInt(sliceHex(sig.signature, 1, 33))
    const s = BigInt(sliceHex(sig.signature, 33, 65))
    if (v > 1n)
      throw new FrameEncodeError(
        `signature ${index}: v must be a bare recovery id (0 or 1), got ${v}`,
      )
    if (r === 0n || r >= SECP256K1_N)
      throw new FrameEncodeError(`signature ${index}: r must be in (0, n)`)
    if (s === 0n || s > SECP256K1_N / 2n)
      throw new FrameEncodeError(`signature ${index}: s must be low (0 < s <= n/2)`)
    return
  }

  const len = signatureByteLength(sig.signature, index)
  if (len !== 128)
    throw new FrameEncodeError(
      `signature ${index}: p256 must be 128 bytes (r||s||qx||qy), got ${len}`,
    )
  const r = BigInt(sliceHex(sig.signature, 0, 32))
  const s = BigInt(sliceHex(sig.signature, 32, 64))
  if (r === 0n || r >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: r must be in (0, n)`)
  if (s === 0n || s > SECP256R1_N / 2n)
    throw new FrameEncodeError(
      `signature ${index}: s must be low (0 < s <= n/2); P256VERIFY accepts high s, so normalize to n - s before signing`,
    )
}

/** An empty `signer` resolves to `tx.sender`, including for EVM introspection. */
export function resolveSigner(tx: FrameTransaction, index: number): Address {
  const sig = tx.signatures[index]
  if (sig === undefined) throw new FrameEncodeError(`no signature at index ${index}`)
  if (sig.scheme === 0)
    throw new FrameEncodeError(
      `signature ${index}: an ARBITRARY entry has no resolved signer`,
    )
  return sig.signer ?? tx.sender
}

/** Recover the address that produced a SECP256K1 frame signature. */
export function recoverFrameSigner(
  tx: FrameTransaction,
  index: number,
): Promise<Address> {
  const sig = tx.signatures[index]
  if (sig === undefined) throw new FrameEncodeError(`no signature at index ${index}`)
  if (sig.scheme !== 1)
    throw new FrameEncodeError(
      `signature ${index}: recovery is only defined for secp256k1`,
    )
  assertCanonicalSignature(sig, index)

  const digest = sig.msg === '0x' ? frameTxSigHash(tx) : sig.msg
  const v = BigInt(sliceHex(sig.signature, 0, 1))
  const r = sliceHex(sig.signature, 1, 33)
  const s = sliceHex(sig.signature, 33, 65)

  // viem expects r||s||v with v as 27/28; the frame layout is v||r||s with a bare id.
  const viemSignature = `${r}${s.slice(2)}${(v + 27n).toString(16)}` as Hex
  return recoverAddress({ hash: digest, signature: viemSignature })
}

/**
 * Sign every empty-`msg` SECP256K1 entry over the transaction's sig-hash.
 *
 * Idempotent: the sig-hash elides empty-`msg` signature bytes, so re-signing an
 * already-signed transaction produces the same bytes.
 */
export async function signFrameTx(
  tx: FrameTransaction,
  privateKey: Hex,
): Promise<FrameTransaction> {
  const account = privateKeyToAccount(privateKey)
  const digest = frameTxSigHash(tx)

  const signatures = await Promise.all(
    tx.signatures.map(async (sig, i) => {
      if (sig.scheme !== 1 || sig.msg !== '0x') return sig

      // An entry names its own signer (or, if empty, resolves to tx.sender). Signing
      // it with this key when that resolved signer is some OTHER address would
      // produce a signature that recovers to the wrong address — a transaction the
      // chain rejects at consensus, with no error from this library unless we check.
      const resolvedSigner = sig.signer ?? tx.sender
      if (!sameAddress(resolvedSigner, account.address))
        throw new FrameEncodeError(
          `signature ${i}: resolved signer ${resolvedSigner} does not match ` +
            `the signing account ${account.address}`,
        )

      const flat = await account.sign({ hash: digest })
      // viem returns r||s||v with v in {27,28}; the frame layout is v||r||s with a bare id.
      const r = sliceHex(flat, 0, 32)
      const s = sliceHex(flat, 32, 64)
      const v = BigInt(sliceHex(flat, 64, 65)) - 27n
      const signature = `0x${v.toString(16).padStart(2, '0')}${r.slice(2)}${s.slice(2)}` as Hex
      return { ...sig, signature }
    }),
  )

  const signed = { ...tx, signatures }
  signed.signatures.forEach((sig, i) => assertCanonicalSignature(sig, i))
  return signed
}

/**
 * Strict-encode entry point: run every consensus-checked validity rule before
 * any bytes are produced.
 *
 * `encodeFrameTx` itself does not call this — `frameTxSigHash` is defined over
 * a re-encoding of the (possibly signature-elided) transaction, so a validating
 * encoder would validate on every hash computed and on every re-encode of live
 * chain data in the survey suite, most of which is deliberately re-encoding
 * transactions this library did not construct. Call `assertValidFrameTx(tx)`
 * yourself before `encodeFrameTx(tx)` when building a transaction to relay.
 */
export function assertValidFrameTx(tx: FrameTransaction): void {
  validateFrameTx(tx)

  tx.signatures.forEach((sig, i) => assertCanonicalSignature(sig, i))

  tx.frames.forEach((frame, i) => {
    try {
      byteLength(frame.data)
    } catch (err) {
      if (err instanceof FrameRlpError)
        throw new FrameEncodeError(`frame ${i}: data ${err.message}`)
      throw err
    }
  })

  tx.signatures.forEach((sig, i) => {
    for (const [field, value] of [
      ['msg', sig.msg],
      ['signature', sig.signature],
    ] as const) {
      try {
        byteLength(value)
      } catch (err) {
        if (err instanceof FrameRlpError)
          throw new FrameEncodeError(`signature ${i}: ${field} ${err.message}`)
        throw err
      }
    }
  })

  tx.recentRootReferences.forEach((ref, i) => {
    for (const [field, value] of [
      ['sourceId', ref.sourceId],
      ['root', ref.root],
    ] as const) {
      try {
        byteLength(value)
      } catch (err) {
        if (err instanceof FrameRlpError)
          throw new FrameEncodeError(`recentRootReference ${i}: ${field} ${err.message}`)
        throw err
      }
    }
  })
}
