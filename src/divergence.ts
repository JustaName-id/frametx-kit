import { type FrameGas, frameTxGas } from './gas.js'
import type { FrameTransaction, RuleSet } from './types.js'

/**
 * EIP-8250 at head: the first use of a keyed nonce moved from 20,000 execution
 * gas, deducted from the frame's remaining gas, to 97,920 STATE gas charged
 * during the payment APPROVE and attributed to the frame that calls it.
 *
 * A frame consuming two fresh nullifier keys needs 195,840 of limits.state under
 * the head draft, and none on this chain. Adopting it is a re-genesis.
 */
export const HEAD_KEYED_NONCE_STATE_GAS = 97_920n

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
 */
export function compareRuleSets(
  tx: FrameTransaction,
  a: RuleSet,
  b: RuleSet,
): GasDivergence[] {
  const gasA = frameTxGas(tx, a)
  const gasB = frameTxGas(tx, b)

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
