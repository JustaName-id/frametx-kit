import { type Hex, concatHex, toRlp, fromRlp, getAddress, type Address } from 'viem'
import type {
  Frame,
  FrameSignature,
  FrameTransaction,
  RecentRootReference,
  FrameLimits,
  FrameMode,
  SigScheme,
} from './types.js'
import { rlpUint, byteLength, parseRlpUint } from './rlp.js'
import { FrameDecodeError, FrameEncodeError } from './errors.js'

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

function asList(node: RlpTree, what: string): RlpTree[] {
  if (!Array.isArray(node)) throw new FrameDecodeError(`${what} must be an RLP list`)
  return node
}

function asHex(node: RlpTree, what: string): Hex {
  if (Array.isArray(node)) throw new FrameDecodeError(`${what} must be an RLP string`)
  return node
}

function asAddressOrNull(node: RlpTree, what: string): Address | null {
  const hex = asHex(node, what)
  if (hex === '0x') return null
  if (byteLength(hex) !== 20)
    throw new FrameDecodeError(`${what} must be 20 bytes, got ${byteLength(hex)}`)
  return getAddress(hex)
}

function decodeLimits(node: RlpTree): FrameLimits {
  const parts = asList(node, 'frame.limits')
  if (parts.length !== 2)
    throw new FrameDecodeError(`frame.limits must have 2 fields, got ${parts.length}`)
  return {
    execution: parseRlpUint(asHex(parts[0]!, 'limits.execution')),
    state: parseRlpUint(asHex(parts[1]!, 'limits.state')),
  }
}

function decodeFrame(node: RlpTree): Frame {
  const f = asList(node, 'frame')
  if (f.length !== 6)
    throw new FrameDecodeError(`frame must have 6 fields, got ${f.length}`)
  const mode = Number(parseRlpUint(asHex(f[0]!, 'frame.mode')))
  const flags = Number(parseRlpUint(asHex(f[1]!, 'frame.flags')))
  if (mode !== 0 && mode !== 1 && mode !== 2)
    throw new FrameDecodeError(`unsupported frame mode ${mode}`)
  return {
    mode: mode as FrameMode,
    flags,
    target: asAddressOrNull(f[2]!, 'frame.target'),
    limits: decodeLimits(f[3]!),
    value: parseRlpUint(asHex(f[4]!, 'frame.value')),
    data: asHex(f[5]!, 'frame.data'),
  }
}

function decodeSignature(node: RlpTree): FrameSignature {
  const s = asList(node, 'signature')
  if (s.length !== 4)
    throw new FrameDecodeError(`signature must have 4 fields, got ${s.length}`)
  const scheme = Number(parseRlpUint(asHex(s[0]!, 'signature.scheme')))
  if (scheme !== 0 && scheme !== 1 && scheme !== 2)
    throw new FrameDecodeError(`unsupported signature scheme ${scheme}`)
  return {
    scheme: scheme as SigScheme,
    signer: asAddressOrNull(s[1]!, 'signature.signer'),
    msg: asHex(s[2]!, 'signature.msg'),
    signature: asHex(s[3]!, 'signature.signature'),
  }
}

function decodeRecentRootReference(node: RlpTree): RecentRootReference {
  const r = asList(node, 'recentRootReference')
  if (r.length !== 3)
    throw new FrameDecodeError(
      `recentRootReference must have 3 fields, got ${r.length}`,
    )
  return {
    sourceId: asHex(r[0]!, 'recentRootReference.sourceId'),
    slot: parseRlpUint(asHex(r[1]!, 'recentRootReference.slot')),
    root: asHex(r[2]!, 'recentRootReference.root'),
  }
}

/**
 * Decode a type-0x06 frame transaction. Lenient by design: it decodes anything
 * the chain accepted, and does not apply the encode-side structural rules.
 *
 * The spec's "opt-in strict decode" is this function followed by
 * `validateFrameTx` (Task 4) rather than a boolean parameter — same guarantee,
 * and the strict rules stay in one place instead of two.
 */
export function decodeFrameTx(raw: Hex): FrameTransaction {
  if (!raw.startsWith('0x06'))
    throw new FrameDecodeError(`expected type 0x06, got ${raw.slice(0, 4)}`, 0)

  const body = `0x${raw.slice(4)}` as Hex
  let tree: RlpTree
  try {
    tree = fromRlp(body, 'hex') as RlpTree
  } catch (cause) {
    throw new FrameDecodeError(`malformed RLP body: ${(cause as Error).message}`, 1)
  }

  const fields = asList(tree, 'envelope')
  if (fields.length !== 9)
    throw new FrameDecodeError(`envelope must have 9 fields, got ${fields.length}`, 1)

  const fees = asList(fields[6]!, 'fees')
  if (fees.length !== 3)
    throw new FrameDecodeError(`fees must have 3 fields, got ${fees.length}`)

  const sender = asAddressOrNull(fields[3]!, 'sender')
  if (sender === null) throw new FrameDecodeError('sender may not be empty')

  return {
    chainId: parseRlpUint(asHex(fields[0]!, 'chainId')),
    nonceKeys: asList(fields[1]!, 'nonceKeys').map((k) =>
      parseRlpUint(asHex(k, 'nonceKeys[]')),
    ),
    nonceSeq: parseRlpUint(asHex(fields[2]!, 'nonceSeq')),
    sender,
    frames: asList(fields[4]!, 'frames').map(decodeFrame),
    signatures: asList(fields[5]!, 'signatures').map(decodeSignature),
    maxPriorityFeePerGas: parseRlpUint(asHex(fees[0]!, 'maxPriorityFeePerGas')),
    maxFeePerGas: parseRlpUint(asHex(fees[1]!, 'maxFeePerGas')),
    maxFeePerBlobGas: parseRlpUint(asHex(fees[2]!, 'maxFeePerBlobGas')),
    blobVersionedHashes: asList(fields[7]!, 'blobVersionedHashes').map((h) =>
      asHex(h, 'blobVersionedHashes[]'),
    ),
    recentRootReferences: asList(fields[8]!, 'recentRootReferences').map(
      decodeRecentRootReference,
    ),
  }
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

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isExpiryVerifier(frame: Frame): boolean {
  return frame.mode === 1 && frame.target !== null && sameAddress(frame.target, EXPIRY_VERIFIER)
}

/**
 * The encode-side structural rules, transcribed from
 * `FrameTransaction::validate_static_constraints` (transaction.rs:2662-3010).
 *
 * Strict on purpose: these are consensus rules, so producing a transaction that
 * violates one is producing an invalid transaction, not merely an unrelayable
 * one. Rules that need chain state — nonce values, recent-root windows, the
 * EIP-7825 cap against the block gas limit, the validation prefix itself — are
 * the node's; `simulateFrameTransaction` (Task 8) replays them.
 *
 * Mode 5 (UTXO) rules are omitted: `utxoFramesTime` is unset on this chain and
 * `FrameMode` does not admit 5.
 */
export function validateFrameTx(tx: FrameTransaction): void {
  if (sameAddress(tx.sender, ZERO_ADDRESS))
    throw new FrameEncodeError('sender must not be the zero address')

  if (tx.frames.length === 0)
    throw new FrameEncodeError('a frame transaction needs at least one frame')
  if (tx.frames.length > MAX_FRAMES)
    throw new FrameEncodeError(`at most ${MAX_FRAMES} frames, got ${tx.frames.length}`)

  if (tx.nonceKeys.length < 1 || tx.nonceKeys.length > MAX_NONCE_KEYS)
    throw new FrameEncodeError(
      `nonceKeys must hold between 1 and ${MAX_NONCE_KEYS} entries, got ${tx.nonceKeys.length}`,
    )
  for (let i = 1; i < tx.nonceKeys.length; i++)
    if (tx.nonceKeys[i - 1]! >= tx.nonceKeys[i]!)
      throw new FrameEncodeError('nonceKeys must be strictly increasing')
  if (tx.nonceKeys.length > 1 && tx.nonceKeys[0] === 0n)
    throw new FrameEncodeError(
      'the first nonce key may only be zero when it is the only key',
    )
  if (tx.nonceSeq >= U64_MAX)
    throw new FrameEncodeError('nonceSeq must be below 2**64 - 1')

  if (tx.recentRootReferences.length > MAX_RECENT_ROOT_REFERENCES)
    throw new FrameEncodeError(
      `at most ${MAX_RECENT_ROOT_REFERENCES} recent-root references, got ${tx.recentRootReferences.length}`,
    )

  if (tx.blobVersionedHashes.length > MAX_BLOBS_PER_TX)
    throw new FrameEncodeError(
      `at most ${MAX_BLOBS_PER_TX} blobs, got ${tx.blobVersionedHashes.length}`,
    )
  for (const [i, hash] of tx.blobVersionedHashes.entries())
    if (byteLength(hash) !== 32 || !hash.startsWith('0x01'))
      throw new FrameEncodeError(
        `blob hash ${i}: must be 32 bytes and carry the KZG version byte 0x01`,
      )
  if (tx.blobVersionedHashes.length === 0 && tx.maxFeePerBlobGas !== 0n)
    throw new FrameEncodeError(
      'maxFeePerBlobGas must be zero when the transaction carries no blobs',
    )

  for (const [i, sig] of tx.signatures.entries()) {
    if (sig.scheme === 0 && sig.signer !== null)
      throw new FrameEncodeError(`signature ${i}: an ARBITRARY entry must have an empty signer`)
    if (sig.msg !== '0x') {
      if (byteLength(sig.msg) !== 32)
        throw new FrameEncodeError(
          `signature ${i}: msg must be empty or 32 bytes, got ${byteLength(sig.msg)}`,
        )
      if (/^0x0+$/.test(sig.msg))
        throw new FrameEncodeError(`signature ${i}: an explicit msg must not be the zero digest`)
    }
  }

  let expiryFrames = 0
  let cumulativeGas = 0n
  for (const [i, frame] of tx.frames.entries()) {
    if ((frame.flags & RESERVED_FLAG_BITS) !== 0)
      throw new FrameEncodeError(`frame ${i}: flag bits 3-7 are reserved and must be zero`)
    if (frame.value !== 0n && frame.mode !== 2)
      throw new FrameEncodeError(`frame ${i}: only SENDER frames may carry value`)

    // ethrex bounds both dimensions at i64::MAX, stricter than the EIP's 2**64-1,
    // so its i64 state-gas accounting cannot overflow (transaction.rs:2924-2950).
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
      if (byteLength(frame.data) !== 8)
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
