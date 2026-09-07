import type { Address, Hex } from 'viem'

/** 0 DEFAULT, 1 VERIFY, 2 SENDER. Mode 5 (UTXO, EIP-8312) is inert on this chain. */
export type FrameMode = 0 | 1 | 2

/** 0 ARBITRARY, 1 SECP256K1, 2 P256. */
export type SigScheme = 0 | 1 | 2

/** EIP-8141 `limits`, always encoded as a two-element list. */
export type FrameLimits = {
  execution: bigint
  /** EIP-8037 state gas. */
  state: bigint
}

export type Frame = {
  mode: FrameMode
  /** Bits 0-1 APPROVE scope, bit 2 atomic batch, bits 3-7 reserved and zero. */
  flags: number
  /** `null` means "use tx.sender". */
  target: Address | null
  limits: FrameLimits
  /** Must be zero unless the frame is SENDER. */
  value: bigint
  data: Hex
}

export type FrameSignature = {
  scheme: SigScheme
  /** `null` resolves to tx.sender for SECP256K1/P256; MUST be null for ARBITRARY. */
  signer: Address | null
  /** '0x' is the canonical sig-hash case; otherwise a 32-byte digest. */
  msg: Hex
  /** SECP256K1: v||r||s, 65 bytes, v a bare recovery id. P256: r||s||qx||qy, 128 bytes. */
  signature: Hex
}

export type RecentRootReference = {
  /** 32 bytes. */
  sourceId: Hex
  slot: bigint
  /** 32 bytes. */
  root: Hex
}

export type FrameTransaction = {
  chainId: bigint
  /** 1..16 entries, strictly increasing; if more than one, the first is non-zero. */
  nonceKeys: bigint[]
  nonceSeq: bigint
  sender: Address
  frames: Frame[]
  signatures: FrameSignature[]
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  maxFeePerBlobGas: bigint
  blobVersionedHashes: Hex[]
  recentRootReferences: RecentRootReference[]
}

/**
 * Which rule set to price under.
 * - 'chain' — ethrex 31b532266, the deployed binary, with its two live divergences.
 * - 'pins'  — the pinned EIP text: 8141 7d1c8bfb94, 8250 e5cf246ff1, 8272 0231fb05f5.
 * - 'head'  — current drafts, for anticipating the next re-genesis. Models only
 *   the EIP-8250 gas change; the EIP-8272 head draft changes the *envelope*
 *   (recent-root references become a leading VERIFY frame), not just the
 *   price, so `frameTxGas` refuses rather than guess at a reference-carrying
 *   transaction under `'head'`. Price one through `compareRuleSets`, which
 *   routes it via `toHeadShape`, or call that transform directly.
 */
export type RuleSet = 'chain' | 'pins' | 'head'
