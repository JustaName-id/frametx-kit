import { type Address, type Hex, recoverAddress, sliceHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sameAddress, validateFrameTx } from './envelope.js'
import { FrameEncodeError, FrameRlpError } from './errors.js'
import { byteLength } from './rlp.js'
import { frameTxSigHash } from './sighash.js'
import type { FrameSignature, FrameTransaction } from './types.js'

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

/**
 * Rewrite a P256 signature to low-`s` form: `r || s || qx || qy` (128 bytes)
 * with `s` replaced by `n - s` when `s > n/2`.
 *
 * ECDSA is malleable — `(r, s)` and `(r, n - s)` verify the same message against
 * the same key — so this keeps the signature valid while satisfying the
 * consensus rule that a frame's `s` be low. `P256VERIFY` itself accepts high
 * `s`, and WebAuthn and passkey signers routinely emit it, so anything wiring
 * one into a frame transaction needs this or the chain rejects the transaction.
 *
 * The embedded public key is untouched: `(r, n - s)` recovers against the same
 * `(qx, qy)`. Structurally malformed input — wrong length, `r` or `s` outside
 * `(0, n)` — throws rather than being silently repaired.
 */
export function normalizeP256Signature(signature: Hex, index = 0): Hex {
  const len = signatureByteLength(signature, index)
  if (len !== 128)
    throw new FrameEncodeError(
      `signature ${index}: p256 must be 128 bytes (r||s||qx||qy), got ${len}`,
    )
  const r = BigInt(sliceHex(signature, 0, 32))
  const s = BigInt(sliceHex(signature, 32, 64))
  if (r === 0n || r >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: r must be in (0, n)`)
  if (s === 0n || s >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: s must be in (0, n)`)

  const low = s > SECP256R1_N / 2n ? SECP256R1_N - s : s
  const body = signature.slice(2)
  return `0x${body.slice(0, 64)}${low.toString(16).padStart(64, '0')}${body.slice(128)}` as Hex
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

/**
 * Recover the address that produced a SECP256K1 frame signature.
 *
 * `async` deliberately: the guard clauses below would otherwise throw
 * synchronously out of a function typed `Promise<Address>`, so a caller's
 * `.catch()` (or `rejects.toThrow`) would never see them.
 */
export async function recoverFrameSigner(
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
 * Reduce whatever `v` a signer returned to the bare recovery id the frame layout
 * wants. viem returns 27/28; an HSM or a hand-rolled wrapper may return 0/1.
 *
 * Subtracting 27 unconditionally turns a bare id into a negative number and
 * writes `0x-1a…` into the signature — malformed hex that only trips the
 * byte-alignment check downstream, with a message that names the wrong problem.
 * An EIP-155 `v` is refused outright: it encodes a chain id this layout has no
 * room for, and guessing at its parity would forge a recovery id.
 */
function bareRecoveryId(v: bigint, index: number): bigint {
  if (v === 0n || v === 1n) return v
  if (v === 27n || v === 28n) return v - 27n
  throw new FrameEncodeError(
    `signature ${index}: signer returned v=${v}; expected a bare recovery id ` +
      `(0 or 1) or viem's 27/28. An EIP-155 v is not supported here — the frame ` +
      `layout carries a bare id and the chain id is a separate field.`,
  )
}

/**
 * Anything that can sign a raw 32-byte digest for a known address: viem's
 * `privateKeyToAccount` and `mnemonicToAccount`, a `toAccount` source, or a
 * hand-rolled wrapper around a hardware wallet, an HSM or a remote signer.
 *
 * `sign` is optional because it is optional on viem's own `LocalAccount` — a
 * `toAccount` source need not provide it — so requiring it here would reject
 * every `LocalAccount` at the type level. `signFrameTx` checks for it instead.
 *
 * `signMessage` is deliberately not an accepted substitute: it prefixes its
 * argument per EIP-191, so it cannot produce a signature over a sig-hash.
 */
export type FrameAccount = {
  address: Address
  sign?: ((parameters: { hash: Hex }) => Promise<Hex>) | undefined
  /**
   * Sign a raw 32-byte digest with P256 / secp256r1, returning
   * `r || s || qx || qy` (128 bytes) with any `s`. `signFrameTx` runs the
   * result through `normalizeP256Signature`, so a WebAuthn or passkey signer
   * that hands back high-`s` needs nothing extra.
   *
   * `signFrameTx` does not verify a P256 signature — scheme 2 has no address
   * recovery — so the signer owns the correctness of `r`, `s` and the embedded
   * public key; the library owns only the wire form.
   */
  signP256?: ((parameters: { hash: Hex }) => Promise<Hex>) | undefined
}

/**
 * Sign every empty-`msg` entry this account can sign, over the transaction's
 * sig-hash: SECP256K1 entries with the account's `sign`, and — when the account
 * carries a `signP256` — P256 entries too, normalized to low-`s`. An ARBITRARY
 * entry, and a P256 entry with no `signP256` available, are left untouched.
 *
 * Takes either a raw private key or a `FrameAccount` — a hardware wallet, a
 * KMS, an HD account, a passkey wrapper, anything that signs a digest for a
 * known address.
 *
 * Idempotent for SECP256K1: the sig-hash elides empty-`msg` signature bytes, so
 * re-signing produces the same bytes. A P256 signer that is itself
 * nondeterministic is re-invoked on every call.
 */
export async function signFrameTx(
  tx: FrameTransaction,
  signer: Hex | FrameAccount,
): Promise<FrameTransaction> {
  const account: FrameAccount =
    typeof signer === 'string' ? privateKeyToAccount(signer) : signer
  const sign = account.sign
  const signP256 = account.signP256
  if (typeof sign !== 'function' && typeof signP256 !== 'function')
    throw new FrameEncodeError(
      `account ${account.address} cannot sign a raw 32-byte digest: it has ` +
        `neither a \`sign\` nor a \`signP256\` method. A JSON-RPC account cannot ` +
        `sign one at all, and \`signMessage\` is not a substitute — it ` +
        `EIP-191-prefixes its argument.`,
    )
  const digest = frameTxSigHash(tx)

  const signatures = await Promise.all(
    tx.signatures.map(async (sig, i) => {
      if (sig.msg !== '0x') return sig
      if (sig.scheme !== 1 && sig.scheme !== 2) return sig

      // An entry names its own signer (or, if empty, resolves to tx.sender).
      // Signing it for a different address produces a signature that fails
      // authentication at consensus with no local error, so it is refused here.
      const resolvedSigner = sig.signer ?? tx.sender
      const assertResolvedSigner = () => {
        if (!sameAddress(resolvedSigner, account.address))
          throw new FrameEncodeError(
            `signature ${i}: resolved signer ${resolvedSigner} does not match ` +
              `the signing account ${account.address}`,
          )
      }

      if (sig.scheme === 1) {
        if (typeof sign !== 'function')
          throw new FrameEncodeError(
            `signature ${i}: a SECP256K1 entry needs a \`sign\` method; this ` +
              `account only signs P256.`,
          )
        assertResolvedSigner()
        const flat = await sign({ hash: digest })
        // viem returns r||s||v with v in {27,28}; the frame layout is v||r||s with a bare id.
        const r = sliceHex(flat, 0, 32)
        const s = sliceHex(flat, 32, 64)
        const v = bareRecoveryId(BigInt(sliceHex(flat, 64, 65)), i)
        const signature = `0x${v.toString(16).padStart(2, '0')}${r.slice(2)}${s.slice(2)}` as Hex
        return { ...sig, signature }
      }

      // scheme 2 — P256. Left to the caller when no P256 signer is available,
      // the same as an ARBITRARY entry.
      if (typeof signP256 !== 'function') return sig
      assertResolvedSigner()
      const raw = await signP256({ hash: digest })
      return { ...sig, signature: normalizeP256Signature(raw, i) }
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
 *
 * Every structural rule — field widths and the byte-alignment of every hex
 * field included — lives in `validateFrameTx`, so this adds exactly the one
 * thing that function cannot see: signature canonicality, which needs the
 * scheme-specific curve order.
 */
export function assertValidFrameTx(tx: FrameTransaction): void {
  validateFrameTx(tx)
  tx.signatures.forEach((sig, i) => assertCanonicalSignature(sig, i))
}
