import { type Address, type Hex, concatHex, numberToHex } from 'viem'
import { type FrameGas, frameTxGas } from './gas.js'
import type { Frame, FrameTransaction, RecentRootReference, RuleSet } from './types.js'

/**
 * EIP-8250 at head: the first use of a keyed nonce moved from 20,000 execution
 * gas, deducted from the frame's remaining gas, to 97,920 STATE gas charged
 * during the payment APPROVE and attributed to the frame that calls it.
 *
 * A frame consuming two fresh nullifier keys needs 195,840 of limits.state under
 * the head draft, and none on this chain. Adopting it is a re-genesis.
 */
export const HEAD_KEYED_NONCE_STATE_GAS = 97_920n

/**
 * EIP-8272 at head: the envelope field, `TXPARAM 0x11` and `RECENTROOTREFLOAD` are
 * gone. References travel instead as a leading VERIFY frame against this address.
 */
export const HEAD_RECENT_ROOT_VERIFIER: Address =
  '0x0000000000000000000000000000000000008272'

/** One packed reference: 32-byte source id, 8-byte slot, 32-byte root. */
export const HEAD_REFERENCE_BYTES = 72

// The slot takes 8 bytes because `validateFrameTx` already holds it to a u64
// (envelope.ts, `assertUint(ref.slot, 64, …)`), which is also the only width that
// adds up to the draft's 72.
function packReference(ref: RecentRootReference): Hex {
  return concatHex([ref.sourceId, numberToHex(ref.slot, { size: 8 }), ref.root])
}

/**
 * The head-shaped equivalent of a reference-carrying transaction: the envelope
 * field emptied, its contents prepended as one VERIFY frame.
 *
 * The synthetic frame's limits are zero because no draft pins what a VERIFY
 * against `0x…8272` costs. Every limit-derived gas term of the result is
 * therefore a floor, which is why this is the divergence survey's entry point and
 * `frameTxGas(tx, 'head')` still refuses a reference-carrying transaction: a
 * floor is fine to compare against and wrong to budget with.
 *
 * Identity for a transaction that carries no reference.
 */
export function toHeadShape(tx: FrameTransaction): FrameTransaction {
  if (tx.recentRootReferences.length === 0) return tx

  const verify: Frame = {
    mode: 1,
    flags: 0,
    target: HEAD_RECENT_ROOT_VERIFIER,
    limits: { execution: 0n, state: 0n },
    value: 0n,
    data: concatHex(tx.recentRootReferences.map(packReference)),
  }
  return { ...tx, frames: [verify, ...tx.frames], recentRootReferences: [] }
}

export type GasDivergence = {
  term: keyof FrameGas
  a: bigint
  b: bigint
  /** Always non-negative: the absolute difference between the two rule sets. */
  delta: bigint
}

/**
 * Every gas term on which two rule sets disagree for this transaction.
 *
 * An empty result means the transaction is priced identically under both — which
 * is the common case, because the live divergences are narrow. A non-empty result
 * on live chain data that the divergence ledger does not already explain is a
 * finding worth reporting.
 *
 * Whichever side names `'head'` is priced over `toHeadShape(tx)`, so a
 * reference-carrying transaction compares against the head envelope rather than
 * being refused. Both sides are transformed independently, so argument order
 * never changes the outcome.
 */
export function compareRuleSets(
  tx: FrameTransaction,
  a: RuleSet,
  b: RuleSet,
): GasDivergence[] {
  const gasA = frameTxGas(a === 'head' ? toHeadShape(tx) : tx, a)
  const gasB = frameTxGas(b === 'head' ? toHeadShape(tx) : tx, b)

  const divergences: GasDivergence[] = []
  for (const term of Object.keys(gasA) as (keyof FrameGas)[]) {
    const left = gasA[term]
    const right = gasB[term]
    if (left === right) continue
    divergences.push({
      term,
      a: left,
      b: right,
      delta: left > right ? left - right : right - left,
    })
  }
  return divergences
}
