import { type Address, type Hex, concatHex, toRlp } from 'viem'
import { FrameEncodeError } from './errors.js'
import { byteLength, rlpUint } from './rlp.js'
import type { FrameTransaction, RuleSet, SigScheme } from './types.js'

// EIP-8141 Constants table. Written as published figures, never derived: ethrex's
// own suite missed the intrinsic dropping from 15000 to 12000 across 1372 tests
// because it derived the expected value from the constant under test.
export const FRAME_TX_INTRINSIC_COST = 12_000n
export const FRAME_TX_PER_FRAME_COST = 475n
export const FRAME_TX_VALUE_COST = 6_000n
export const STANDARD_TOKEN_COST = 4n
export const TOTAL_COST_FLOOR_PER_TOKEN = 16n
export const GAS_PER_BLOB = 131_072n

/** EIP-8272: ACCESS_LIST_ADDRESS_COST, and
 *  ACCESS_LIST_STORAGE_KEY_COST + 2*KECCAK256_BASE_GAS + 7*KECCAK256_WORD_GAS. */
export const RECENT_ROOT_REFERENCE_ADDRESS_GAS = 2_400n
export const RECENT_ROOT_REFERENCE_GAS = 2_002n

export const SIG_VERIFY_COST: Record<SigScheme, bigint> = {
  0: 100n,
  1: 2_800n,
  2: 6_700n,
}

export type FrameGas = {
  valueTransferCost: bigint
  signatureVerificationCost: bigint
  mandatoryGas: bigint
  /** Total length in bytes of every billed field. */
  billedBytes: bigint
  dataCost: bigint
  recentRootReferenceGas: bigint
  intrinsicGas: bigint
  stateGasLimit: bigint
  standardGasLimit: bigint
  calldataTokens: bigint
  calldataFloorGas: bigint
  calldataFloorTotal: bigint
  /** `max_gas`: the gas reserved from the block pool. */
  maxGas: bigint
}

/** EIP-8250 `nonce_calldata`: rlp(nonce_keys) || rlp(nonce_seq). */
export function nonceCalldata(tx: FrameTransaction): Hex {
  return concatHex([toRlp(tx.nonceKeys.map(rlpUint), 'hex'), toRlp(rlpUint(tx.nonceSeq), 'hex')])
}

/**
 * EIP-8272 `recent_root_calldata`: rlp(recent_root_references), or EMPTY when no
 * reference is declared — not `toRlp([])`, which would add a billed byte to every
 * transaction on the chain.
 */
export function recentRootCalldata(tx: FrameTransaction): Hex {
  if (tx.recentRootReferences.length === 0) return '0x'
  return toRlp(
    tx.recentRootReferences.map((r) => [r.sourceId, rlpUint(r.slot), r.root]),
    'hex',
  )
}

/**
 * The fields the calldata cost is charged over: each frame's `data`, each
 * signature's `signer`, `msg` and `signature`, the nonce calldata and the
 * recent-root calldata. The envelope's RLP framing and its scalar fields are
 * NOT billed — but the two calldata blobs above are themselves RLP, and their
 * framing bytes are billed.
 */
function billedFields(tx: FrameTransaction): Hex[] {
  return [
    ...tx.frames.map((f) => f.data),
    ...tx.signatures.flatMap((s) => [s.signer ?? '0x', s.msg, s.signature] as Hex[]),
    nonceCalldata(tx),
    recentRootCalldata(tx),
  ]
}

/** EIP-7623 calldata cost: 4 gas per zero byte, 16 per non-zero byte. */
function calldataCost(fields: Hex[]): bigint {
  let total = 0n
  for (const field of fields) {
    const body = field.slice(2)
    for (let i = 0; i < body.length; i += 2)
      total += body.slice(i, i + 2) === '00' ? 4n : 16n
  }
  return total
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * EIP-8141 `value_transfer_cost`.
 *
 * The rule sets differ here, and this is the divergence you can observe on the
 * live chain: ethrex 31b532266 charges every value-carrying frame, while the
 * pinned text charges only a frame whose target is present and is not tx.sender.
 * A targetless or self-targeted value frame is therefore overcharged 6000 on the
 * deployed chain. Divergence-ledger row 3.8.
 */
function valueTransferCost(tx: FrameTransaction, rules: RuleSet): bigint {
  let total = 0n
  for (const frame of tx.frames) {
    if (frame.value === 0n) continue
    if (rules === 'chain') {
      total += FRAME_TX_VALUE_COST
      continue
    }
    // Compare case-insensitively: `getAddress` returns EIP-55 mixed case while a
    // hand-written fixture is lowercase, and a `!==` between the two would charge
    // TX_VALUE_COST on a self-targeted frame that the pinned rule exempts.
    if (frame.target !== null && !sameAddress(frame.target, tx.sender))
      total += FRAME_TX_VALUE_COST
  }
  return total
}

/**
 * Price a frame transaction under a rule set.
 *
 * Only `valueTransferCost` depends on the rule set, and only between `'chain'`
 * and `'pins'`. `'head'` prices identically to `'pins'` here: the head EIP-8250
 * change (97,920 state gas on the first use of a keyed nonce) is an
 * execution-time charge against `limits.state`, not an intrinsic term, so it
 * moves what a builder must budget, not what this function computes. The figure
 * lives in `divergence.ts` as `HEAD_KEYED_NONCE_STATE_GAS`.
 *
 * `'head'` is refused, not modeled, for a transaction that carries any
 * recent-root reference: the head EIP-8272 draft removes the envelope's
 * recent-root field entirely (references become a leading VERIFY frame
 * carrying 72 bytes of data each), so the `2400 + 2002·n` intrinsic term and
 * the billed RLP reference bytes computed here have no head-shaped equivalent
 * to compare against — this function does not model the head envelope shape.
 */
export function frameTxGas(tx: FrameTransaction, rules: RuleSet = 'chain'): FrameGas {
  if (rules === 'head' && tx.recentRootReferences.length > 0)
    throw new FrameEncodeError(
      'the head EIP-8272 draft removes the recent-root envelope field entirely ' +
        '(references become a leading VERIFY frame carrying 72 bytes of data each), ' +
        'so this transaction has no head-shaped equivalent and frameTxGas does not model it',
    )

  const valueCost = valueTransferCost(tx, rules)
  const sigCost = tx.signatures.reduce(
    (acc, s) => acc + SIG_VERIFY_COST[s.scheme],
    0n,
  )
  const mandatoryGas =
    FRAME_TX_INTRINSIC_COST +
    BigInt(tx.frames.length) * FRAME_TX_PER_FRAME_COST +
    sigCost +
    valueCost

  const fields = billedFields(tx)
  const billedBytes = fields.reduce((acc, f) => acc + BigInt(byteLength(f)), 0n)
  const dataCost = calldataCost(fields)

  const recentRootReferenceGas =
    tx.recentRootReferences.length === 0
      ? 0n
      : RECENT_ROOT_REFERENCE_ADDRESS_GAS +
        BigInt(tx.recentRootReferences.length) * RECENT_ROOT_REFERENCE_GAS

  const intrinsicGas = mandatoryGas + dataCost + recentRootReferenceGas

  const stateGasLimit = tx.frames.reduce((acc, f) => acc + f.limits.state, 0n)
  const executionGasLimit = tx.frames.reduce((acc, f) => acc + f.limits.execution, 0n)
  const standardGasLimit = intrinsicGas + executionGasLimit + stateGasLimit

  const calldataTokens = billedBytes * STANDARD_TOKEN_COST
  const calldataFloorGas = calldataTokens * TOTAL_COST_FLOOR_PER_TOKEN
  const calldataFloorTotal = mandatoryGas + recentRootReferenceGas + calldataFloorGas

  // State gas is added ON TOP of the floor: both bound an execution-dimension
  // resource, so the floor branch cannot absorb the state sum.
  const maxGas =
    standardGasLimit > calldataFloorTotal + stateGasLimit
      ? standardGasLimit
      : calldataFloorTotal + stateGasLimit

  return {
    valueTransferCost: valueCost,
    signatureVerificationCost: sigCost,
    mandatoryGas,
    billedBytes,
    dataCost,
    recentRootReferenceGas,
    intrinsicGas,
    stateGasLimit,
    standardGasLimit,
    calldataTokens,
    calldataFloorGas,
    calldataFloorTotal,
    maxGas,
  }
}

/** TXPARAM 0x06: max_gas * max_fee_per_gas + len(blobs) * GAS_PER_BLOB * blob_base_fee. */
export function frameTxMaxCost(
  tx: FrameTransaction,
  blobBaseFee: bigint,
  rules: RuleSet = 'chain',
): bigint {
  const { maxGas } = frameTxGas(tx, rules)
  return (
    maxGas * tx.maxFeePerGas +
    BigInt(tx.blobVersionedHashes.length) * GAS_PER_BLOB * blobBaseFee
  )
}
