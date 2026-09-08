import { type Hex, concatHex, toRlp, getAddress, type Address } from 'viem'
import type {
  Frame,
  FrameSignature,
  FrameTransaction,
  RecentRootReference,
  FrameLimits,
  FrameMode,
  SigScheme,
} from './types.js'
import { type RlpNode, rlpUint, byteLength, parseRlpUint, walkRlp } from './rlp.js'
import { FrameDecodeError, FrameEncodeError, FrameRlpError } from './errors.js'

/** Byte 0 of a frame transaction is the `0x06` type prefix; the RLP body starts at 1. */
const TYPE_PREFIX_BYTES = 1

type RlpTree = Hex | RlpTree[]

function encodeFrame(frame: Frame): RlpTree {
  return [
    rlpUint(BigInt(frame.mode)),
    rlpUint(BigInt(frame.flags)),
    frame.target ?? '0x',
    [rlpUint(frame.limits.execution), rlpUint(frame.limits.state)],
    rlpUint(frame.value),
    frame.data,
  ]
}

function encodeSignature(sig: FrameSignature): RlpTree {
  return [rlpUint(BigInt(sig.scheme)), sig.signer ?? '0x', sig.msg, sig.signature]
}

function encodeRecentRootReference(ref: RecentRootReference): RlpTree {
  return [ref.sourceId, rlpUint(ref.slot), ref.root]
}

/** The RLP body, without the `0x06` type prefix. */
export function encodeFrameTxBody(tx: FrameTransaction): Hex {
  return toRlp(
    [
      rlpUint(tx.chainId),
      tx.nonceKeys.map(rlpUint),
      rlpUint(tx.nonceSeq),
      tx.sender,
      tx.frames.map(encodeFrame),
      tx.signatures.map(encodeSignature),
      [
        rlpUint(tx.maxPriorityFeePerGas),
        rlpUint(tx.maxFeePerGas),
        rlpUint(tx.maxFeePerBlobGas),
      ],
      tx.blobVersionedHashes,
      tx.recentRootReferences.map(encodeRecentRootReference),
    ] satisfies RlpTree,
    'hex',
  )
}

/** The full wire encoding: `0x06 || rlp(body)`. */
export function encodeFrameTx(tx: FrameTransaction): Hex {
  return concatHex(['0x06', encodeFrameTxBody(tx)])
}

function asList(node: RlpNode, what: string): readonly RlpNode[] {
  if (node.kind !== 'list')
    throw new FrameDecodeError(`${what} must be an RLP list`, node.start)
  return node.items
}

function asHex(node: RlpNode, what: string): Hex {
  if (node.kind !== 'string')
    throw new FrameDecodeError(`${what} must be an RLP string`, node.start)
  return node.value
}

/**
 * Read a scalar field as a bigint, turning `parseRlpUint`'s well-formedness
 * complaints (odd-length hex, a non-minimal leading zero byte) into a
 * `FrameDecodeError` that points at the field.
 */
function asUint(node: RlpNode, what: string): bigint {
  try {
    return parseRlpUint(asHex(node, what))
  } catch (err) {
    if (err instanceof FrameRlpError)
      throw new FrameDecodeError(`${what}: ${err.message}`, node.start)
    throw err
  }
}

function asAddressOrNull(node: RlpNode, what: string): Address | null {
  const hex = asHex(node, what)
  if (hex === '0x') return null
  if (byteLength(hex) !== 20)
    throw new FrameDecodeError(`${what} must be 20 bytes, got ${byteLength(hex)}`, node.start)
  return getAddress(hex)
}

function decodeLimits(node: RlpNode): FrameLimits {
  const parts = asList(node, 'frame.limits')
  if (parts.length !== 2)
    throw new FrameDecodeError(
      `frame.limits must have 2 fields, got ${parts.length}`,
      node.start,
    )
  return {
    execution: asUint(parts[0]!, 'limits.execution'),
    state: asUint(parts[1]!, 'limits.state'),
  }
}

function decodeFrame(node: RlpNode): Frame {
  const f = asList(node, 'frame')
  if (f.length !== 6)
    throw new FrameDecodeError(`frame must have 6 fields, got ${f.length}`, node.start)
  const mode = Number(asUint(f[0]!, 'frame.mode'))
  const flags = Number(asUint(f[1]!, 'frame.flags'))
  if (mode !== 0 && mode !== 1 && mode !== 2)
    throw new FrameDecodeError(`unsupported frame mode ${mode}`, f[0]!.start)
  return {
    mode: mode as FrameMode,
    flags,
    target: asAddressOrNull(f[2]!, 'frame.target'),
    limits: decodeLimits(f[3]!),
    value: asUint(f[4]!, 'frame.value'),
    data: asHex(f[5]!, 'frame.data'),
  }
}

function decodeSignature(node: RlpNode): FrameSignature {
  const s = asList(node, 'signature')
  if (s.length !== 4)
    throw new FrameDecodeError(`signature must have 4 fields, got ${s.length}`, node.start)
  const scheme = Number(asUint(s[0]!, 'signature.scheme'))
  if (scheme !== 0 && scheme !== 1 && scheme !== 2)
    throw new FrameDecodeError(`unsupported signature scheme ${scheme}`, s[0]!.start)
  return {
    scheme: scheme as SigScheme,
    signer: asAddressOrNull(s[1]!, 'signature.signer'),
    msg: asHex(s[2]!, 'signature.msg'),
    signature: asHex(s[3]!, 'signature.signature'),
  }
}

function decodeRecentRootReference(node: RlpNode): RecentRootReference {
  const r = asList(node, 'recentRootReference')
  if (r.length !== 3)
    throw new FrameDecodeError(
      `recentRootReference must have 3 fields, got ${r.length}`,
      node.start,
    )
  return {
    sourceId: asHex(r[0]!, 'recentRootReference.sourceId'),
    slot: asUint(r[1]!, 'recentRootReference.slot'),
    root: asHex(r[2]!, 'recentRootReference.root'),
  }
}

function decodeFields(
  fields: readonly RlpNode[],
  fees: readonly RlpNode[],
  sender: Address,
): FrameTransaction {
  return {
    chainId: asUint(fields[0]!, 'chainId'),
    nonceKeys: asList(fields[1]!, 'nonceKeys').map((k) => asUint(k, 'nonceKeys[]')),
    nonceSeq: asUint(fields[2]!, 'nonceSeq'),
    sender,
    frames: asList(fields[4]!, 'frames').map(decodeFrame),
    signatures: asList(fields[5]!, 'signatures').map(decodeSignature),
    maxPriorityFeePerGas: asUint(fees[0]!, 'maxPriorityFeePerGas'),
    maxFeePerGas: asUint(fees[1]!, 'maxFeePerGas'),
    maxFeePerBlobGas: asUint(fees[2]!, 'maxFeePerBlobGas'),
    blobVersionedHashes: asList(fields[7]!, 'blobVersionedHashes').map((h) =>
      asHex(h, 'blobVersionedHashes[]'),
    ),
    recentRootReferences: asList(fields[8]!, 'recentRootReferences').map(
      decodeRecentRootReference,
    ),
  }
}

/**
 * Decode a type-0x06 frame transaction. Lenient about *shapes*: it decodes
 * anything the chain accepted, and does not apply the encode-side structural
 * rules.
 *
 * It is not lenient about RLP well-formedness. The body is walked by `walkRlp`
 * (in `rlp.ts`) rather than viem's `fromRlp`, which accepts non-canonical
 * encodings — the scalar 7 written long-form as `0x8107` rather than `0x07`,
 * say — and quietly returns the canonical value, so a decode followed by an
 * encode would launder bytes the node rejects at RLP decode into bytes it
 * accepts. `walkRlp` rejects those bytes the way ethrex does, and reports the
 * byte offset it found the problem at; every `FrameDecodeError` this function
 * raises carries that offset, counting the `0x06` type byte as byte 0.
 *
 * A re-encoding is still compared against the input as a backstop for any
 * non-canonical shape the walker does not catch directly (compared
 * case-insensitively — viem emits lowercase hex, callers may pass uppercase).
 *
 * Strict decode is this function followed by `assertValidFrameTx` (in
 * `signatures.ts`, which wraps `validateFrameTx` below) rather than a boolean
 * parameter — same guarantee, and the strict rules stay in one place instead of two.
 */
export function decodeFrameTx(raw: Hex): FrameTransaction {
  if (!raw.startsWith('0x06'))
    throw new FrameDecodeError(`expected type 0x06, got ${raw.slice(0, 4)}`, 0)

  const body = `0x${raw.slice(4)}` as Hex
  let tree: RlpNode
  try {
    tree = walkRlp(body, TYPE_PREFIX_BYTES)
  } catch (cause) {
    if (cause instanceof FrameRlpError)
      throw new FrameDecodeError(`malformed RLP body: ${cause.message}`, cause.offset)
    throw cause
  }

  const fields = asList(tree, 'envelope')
  if (fields.length !== 9)
    throw new FrameDecodeError(
      `envelope must have 9 fields, got ${fields.length}`,
      tree.start,
    )

  const fees = asList(fields[6]!, 'fees')
  if (fees.length !== 3)
    throw new FrameDecodeError(
      `fees must have 3 fields, got ${fees.length}`,
      fields[6]!.start,
    )

  const sender = asAddressOrNull(fields[3]!, 'sender')
  if (sender === null)
    throw new FrameDecodeError('sender may not be empty', fields[3]!.start)

  const tx = decodeFields(fields, fees, sender)

  // Backstop: `walkRlp` already rejects a long-form scalar and a non-minimal
  // length prefix at their offset, so this only fires for a canonicality bug the
  // walker misses — an independent check kept because it is cheap and holds for
  // every transaction the chain actually accepted.
  if (encodeFrameTx(tx).toLowerCase() !== raw.toLowerCase())
    throw new FrameDecodeError(
      're-encoding does not reproduce the input bytes: non-canonical RLP, which ethrex rejects at decode',
      TYPE_PREFIX_BYTES,
    )

  return tx
}

export const MAX_FRAMES = 64
export const MAX_NONCE_KEYS = 16
export const MAX_RECENT_ROOT_REFERENCES = 16
/** EIP-7594 per-transaction blob limit; frame transactions inherit it unchanged. */
export const MAX_BLOBS_PER_TX = 6
/** EIP-8141 expiry-verifier predeploy. A VERIFY frame targeting it is an expiry frame. */
export const EXPIRY_VERIFIER: Address = '0x0000000000000000000000000000000000008141'

const APPROVE_PAYMENT = 0x1
const APPROVE_EXECUTION = 0x2
const APPROVE_SCOPE_MASK = APPROVE_PAYMENT | APPROVE_EXECUTION
const ATOMIC_BATCH_FLAG = 0x4
const RESERVED_FLAG_BITS = 0xf8 // bits 3-7
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Address
const U64_MAX = 2n ** 64n - 1n
const I64_MAX = 2n ** 63n - 1n
const U256_MAX = 2n ** 256n - 1n

/** Addresses compare case-insensitively: `getAddress` returns EIP-55 mixed case. */
export function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function assertNonNegative(value: bigint, what: string): void {
  if (value < 0n)
    throw new FrameEncodeError(`${what} must not be negative, got ${value}`)
}

/**
 * Bound a numeric wire field to the width ethrex decodes it at.
 *
 * ethrex's RLP integer decoder (`static_left_pad`) returns `InvalidLength` for
 * any value wider than the destination type, so an out-of-range value here
 * encodes to perfectly well-formed RLP that the node cannot decode at all.
 * Without this the failure surfaces as an opaque relay rejection.
 */
function assertUint(value: bigint, bits: 64 | 256, what: string): void {
  assertNonNegative(value, what)
  const max = bits === 64 ? U64_MAX : U256_MAX
  if (value > max)
    throw new FrameEncodeError(
      `${what} must fit in ${bits} bits (at most 2**${bits} - 1), got ${value}`,
    )
}

/**
 * `byteLength`, reporting a malformed hex field as an encode error rather than
 * an RLP error. Every structural string check in `validateFrameTx` goes through
 * this, so an odd-length or non-hex field throws the same class as any other
 * encode-side violation.
 */
function checkedByteLength(value: Hex, what: string): number {
  try {
    return byteLength(value)
  } catch (err) {
    if (err instanceof FrameRlpError)
      throw new FrameEncodeError(`${what}: ${err.message}`)
    throw err
  }
}

/**
 * A 20-byte address field. `Address` is `0x${string}`, so a wrong-width value
 * typechecks; viem's `toRlp` then left-pads odd-length hex and the encoder emits
 * a field ethrex's H160 decoder refuses with `InvalidLength`. `asAddressOrNull`
 * already enforces this width on the way in, so the encode side has to match.
 */
function assertAddressWidth(value: Address, what: string): void {
  const bytes = checkedByteLength(value, what)
  if (bytes !== 20)
    throw new FrameEncodeError(`${what} must be 20 bytes, got ${bytes}`)
}

function isExpiryVerifier(frame: Frame): boolean {
  return frame.mode === 1 && frame.target !== null && sameAddress(frame.target, EXPIRY_VERIFIER)
}

function assertFieldWidths(tx: FrameTransaction): void {
  // These are the widths ethrex's decoder reads the fields at (`chain_id`,
  // `nonce_seq`, both non-blob fees and `RecentRootReference::slot` are u64;
  // `max_fee_per_blob_gas`, the nonce keys and `Frame::value` are U256).
  assertUint(tx.chainId, 64, 'chainId')
  assertUint(tx.nonceSeq, 64, 'nonceSeq')
  assertUint(tx.maxPriorityFeePerGas, 64, 'maxPriorityFeePerGas')
  assertUint(tx.maxFeePerGas, 64, 'maxFeePerGas')
  assertUint(tx.maxFeePerBlobGas, 256, 'maxFeePerBlobGas')
}

function assertSender(tx: FrameTransaction): void {
  assertAddressWidth(tx.sender, 'sender')
  if (sameAddress(tx.sender, ZERO_ADDRESS))
    throw new FrameEncodeError('sender must not be the zero address')
}

/** Checked before the nonce rules, matching the order in the Rust original. */
function assertFrameCount(tx: FrameTransaction): void {
  if (tx.frames.length === 0)
    throw new FrameEncodeError('a frame transaction needs at least one frame')
  if (tx.frames.length > MAX_FRAMES)
    throw new FrameEncodeError(`at most ${MAX_FRAMES} frames, got ${tx.frames.length}`)
}

function assertNonce(tx: FrameTransaction): void {
  if (tx.nonceKeys.length < 1 || tx.nonceKeys.length > MAX_NONCE_KEYS)
    throw new FrameEncodeError(
      `nonceKeys must hold between 1 and ${MAX_NONCE_KEYS} entries, got ${tx.nonceKeys.length}`,
    )
  for (const [i, key] of tx.nonceKeys.entries()) assertUint(key, 256, `nonceKeys[${i}]`)
  for (let i = 1; i < tx.nonceKeys.length; i++)
    if (tx.nonceKeys[i - 1]! >= tx.nonceKeys[i]!)
      throw new FrameEncodeError('nonceKeys must be strictly increasing')
  if (tx.nonceKeys.length > 1 && tx.nonceKeys[0] === 0n)
    throw new FrameEncodeError(
      'the first nonce key may only be zero when it is the only key',
    )
  if (tx.nonceSeq >= U64_MAX)
    throw new FrameEncodeError('nonceSeq must be below 2**64 - 1')
}

function assertRecentRootReferences(tx: FrameTransaction): void {
  if (tx.recentRootReferences.length > MAX_RECENT_ROOT_REFERENCES)
    throw new FrameEncodeError(
      `at most ${MAX_RECENT_ROOT_REFERENCES} recent-root references, got ${tx.recentRootReferences.length}`,
    )
  // `source_id` and `root` are H256 in ethrex, decoded through the fixed
  // `[u8; 32]` impl: any other length fails RLP decode with InvalidLength.
  for (const [i, ref] of tx.recentRootReferences.entries()) {
    if (checkedByteLength(ref.sourceId, `recentRootReference ${i}: sourceId`) !== 32)
      throw new FrameEncodeError(`recentRootReference ${i}: sourceId must be 32 bytes`)
    if (checkedByteLength(ref.root, `recentRootReference ${i}: root`) !== 32)
      throw new FrameEncodeError(`recentRootReference ${i}: root must be 32 bytes`)
    assertUint(ref.slot, 64, `recentRootReference ${i}: slot`)
  }
}

function assertBlobs(tx: FrameTransaction): void {
  if (tx.blobVersionedHashes.length > MAX_BLOBS_PER_TX)
    throw new FrameEncodeError(
      `at most ${MAX_BLOBS_PER_TX} blobs, got ${tx.blobVersionedHashes.length}`,
    )
  for (const [i, hash] of tx.blobVersionedHashes.entries())
    if (checkedByteLength(hash, `blob hash ${i}`) !== 32 || !hash.startsWith('0x01'))
      throw new FrameEncodeError(
        `blob hash ${i}: must be 32 bytes and carry the KZG version byte 0x01`,
      )
  if (tx.blobVersionedHashes.length === 0 && tx.maxFeePerBlobGas !== 0n)
    throw new FrameEncodeError(
      'maxFeePerBlobGas must be zero when the transaction carries no blobs',
    )
}

function assertSignatures(tx: FrameTransaction): void {
  for (const [i, sig] of tx.signatures.entries()) {
    // Every scheme, ARBITRARY included: the bytes still have to be a byte string.
    checkedByteLength(sig.signature, `signature ${i}: signature`)
    if (sig.scheme === 0 && sig.signer !== null)
      throw new FrameEncodeError(`signature ${i}: an ARBITRARY entry must have an empty signer`)
    if (sig.signer !== null) assertAddressWidth(sig.signer, `signature ${i}: signer`)
    if (sig.msg !== '0x') {
      const msgBytes = checkedByteLength(sig.msg, `signature ${i}: msg`)
      if (msgBytes !== 32)
        throw new FrameEncodeError(
          `signature ${i}: msg must be empty or 32 bytes, got ${msgBytes}`,
        )
      if (/^0x0+$/.test(sig.msg))
        throw new FrameEncodeError(`signature ${i}: an explicit msg must not be the zero digest`)
    }
  }
}

function assertFrames(tx: FrameTransaction): void {
  let expiryFrames = 0
  let cumulativeGas = 0n
  for (const [i, frame] of tx.frames.entries()) {
    if (frame.target !== null) assertAddressWidth(frame.target, `frame ${i}: target`)
    const dataBytes = checkedByteLength(frame.data, `frame ${i}: data`)
    // ethrex decodes `flags` as u64 then `u8::try_from` ("Frame flags too
    // large"). Check the width before the mask: bit 8 and up clear 0xf8.
    if (frame.flags < 0 || frame.flags > 0xff)
      throw new FrameEncodeError(`frame ${i}: flags must fit in one byte, got ${frame.flags}`)
    if ((frame.flags & RESERVED_FLAG_BITS) !== 0)
      throw new FrameEncodeError(`frame ${i}: flag bits 3-7 are reserved and must be zero`)
    assertUint(frame.value, 256, `frame ${i}: value`)
    if (frame.value !== 0n && frame.mode !== 2)
      throw new FrameEncodeError(`frame ${i}: only SENDER frames may carry value`)

    // ethrex bounds both dimensions at i64::MAX, stricter than the EIP's 2**64-1,
    // so its i64 state-gas accounting cannot overflow (transaction.rs:2924-2950).
    assertNonNegative(frame.limits.execution, `frame ${i}: limits.execution`)
    assertNonNegative(frame.limits.state, `frame ${i}: limits.state`)
    if (frame.limits.execution > I64_MAX)
      throw new FrameEncodeError(`frame ${i}: execution limit exceeds 2**63 - 1`)
    cumulativeGas += frame.limits.execution + frame.limits.state
    if (cumulativeGas > I64_MAX)
      throw new FrameEncodeError(`frame ${i}: cumulative frame gas exceeds 2**63 - 1`)

    if (isExpiryVerifier(frame)) {
      expiryFrames += 1
      if (expiryFrames > 1)
        throw new FrameEncodeError(`frame ${i}: more than one expiry verifier frame`)
      if (frame.flags !== 0)
        throw new FrameEncodeError(`frame ${i}: an expiry verifier frame must have flags 0`)
      if (dataBytes !== 8)
        throw new FrameEncodeError(`frame ${i}: expiry verifier data must be 8 bytes`)
      if (frame.limits.state !== 0n)
        throw new FrameEncodeError(`frame ${i}: an expiry verifier frame must have limits.state 0`)
    }

    if (
      (frame.flags & APPROVE_EXECUTION) !== 0 &&
      frame.target !== null &&
      !sameAddress(frame.target, tx.sender)
    )
      throw new FrameEncodeError(
        `frame ${i}: APPROVE_EXECUTION requires an empty target or tx.sender`,
      )

    // Atomic batches (bit 2): never on a VERIFY frame, never on the last frame,
    // never followed by a VERIFY frame; and no frame in a batch — the flagged
    // frame or the one after it — may approve a scope, because a batch unrolls
    // as a unit and an approval granted inside it could outlive the unroll.
    const batched = (frame.flags & ATOMIC_BATCH_FLAG) !== 0
    if (batched) {
      if (frame.mode === 1)
        throw new FrameEncodeError(`frame ${i}: atomic batch flag on a VERIFY frame`)
      const next = tx.frames[i + 1]
      if (next === undefined)
        throw new FrameEncodeError(`frame ${i}: atomic batch flag on the last frame`)
      if (next.mode === 1)
        throw new FrameEncodeError(`frame ${i}: atomic batch flag followed by a VERIFY frame`)
    }
    const previous = i > 0 ? tx.frames[i - 1] : undefined
    const inBatch =
      batched || (previous !== undefined && (previous.flags & ATOMIC_BATCH_FLAG) !== 0)
    if (inBatch && (frame.flags & APPROVE_SCOPE_MASK) !== 0)
      throw new FrameEncodeError(`frame ${i}: a frame in an atomic batch must not approve a scope`)
  }
}

/**
 * The encode-side structural rules, transcribed from
 * `FrameTransaction::validate_static_constraints` (transaction.rs:2662-3010).
 *
 * Strict on purpose: these are consensus rules, so producing a transaction that
 * violates one is producing an invalid transaction, not merely an unrelayable
 * one. Rules that need chain state — nonce values, recent-root windows, the
 * EIP-7825 cap against the block gas limit, the validation prefix itself — are
 * the node's; `simulateFrameTransaction` in `rpc.ts` replays them.
 *
 * Mode 5 (UTXO) rules are omitted: `utxoFramesTime` is unset on this chain and
 * `FrameMode` does not admit 5.
 *
 * The rules are grouped one helper per field family, called in the order the
 * Rust original checks them so the first violation reported matches it.
 */
export function validateFrameTx(tx: FrameTransaction): void {
  assertFieldWidths(tx)
  assertSender(tx)
  assertFrameCount(tx)
  assertNonce(tx)
  assertRecentRootReferences(tx)
  assertBlobs(tx)
  assertSignatures(tx)
  assertFrames(tx)
}
