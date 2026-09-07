import { describe, expect, test } from 'vitest'
import { HEAD_KEYED_NONCE_STATE_GAS, compareRuleSets } from '../src/divergence.js'
import { frameTxGas } from '../src/gas.js'
import { GOLDEN_TX } from './fixtures/golden.js'

/** A SENDER frame carrying value with no target — the shape the chain overcharges. */
const TARGETLESS_VALUE_TX = {
  ...GOLDEN_TX,
  frames: [
    {
      mode: 2 as const,
      flags: 0,
      target: null,
      limits: { execution: 21_000n, state: 0n },
      value: 1n,
      data: '0x' as const,
    },
  ],
}

describe('compareRuleSets', () => {
  test('the golden vector prices identically under chain and pins', () => {
    expect(compareRuleSets(GOLDEN_TX, 'chain', 'pins')).toEqual([])
  })

  test('a targetless value frame diverges by exactly TX_VALUE_COST', () => {
    const divergences = compareRuleSets(TARGETLESS_VALUE_TX, 'chain', 'pins')
    const valueCost = divergences.find((d) => d.term === 'valueTransferCost')
    expect(valueCost).toBeDefined()
    expect(valueCost!.delta).toBe(6_000n)
  })

  test('a self-targeted value frame diverges by exactly TX_VALUE_COST', () => {
    const tx = {
      ...TARGETLESS_VALUE_TX,
      frames: [{ ...TARGETLESS_VALUE_TX.frames[0]!, target: GOLDEN_TX.sender }],
    }
    const valueCost = compareRuleSets(tx, 'chain', 'pins').find(
      (d) => d.term === 'valueTransferCost',
    )
    expect(valueCost!.delta).toBe(6_000n)
  })

  test('a self-targeted frame is exempt regardless of address casing', () => {
    // Regression guard: getAddress returns EIP-55 mixed case, the fixture is
    // lowercase. A case-sensitive comparison charges 6000 here and is wrong.
    const tx = {
      ...TARGETLESS_VALUE_TX,
      sender: '0x000000000000000000000000000000000000ABCD' as const,
      frames: [
        {
          ...TARGETLESS_VALUE_TX.frames[0]!,
          target: '0x000000000000000000000000000000000000abcd' as const,
        },
      ],
    }
    expect(compareRuleSets(tx, 'chain', 'pins')[0]!.delta).toBe(6_000n)
    expect(frameTxGas(tx, 'pins').valueTransferCost).toBe(0n)
  })

  test('a value frame with a third-party target does not diverge', () => {
    const tx = {
      ...TARGETLESS_VALUE_TX,
      frames: [
        {
          ...TARGETLESS_VALUE_TX.frames[0]!,
          target: '0x0000000000000000000000000000000000009999' as const,
        },
      ],
    }
    expect(compareRuleSets(tx, 'chain', 'pins')).toEqual([])
  })

  test('the chain overcharges relative to the pins, never the reverse', () => {
    expect(frameTxGas(TARGETLESS_VALUE_TX, 'chain').maxGas).toBeGreaterThan(
      frameTxGas(TARGETLESS_VALUE_TX, 'pins').maxGas,
    )
  })

  test("'pins' and 'head' never diverge on intrinsic gas", () => {
    expect(compareRuleSets(TARGETLESS_VALUE_TX, 'pins', 'head')).toEqual([])
  })
})

describe('the head draft', () => {
  test('publishes the keyed-nonce state-gas figure', () => {
    // EIP-8250 moved the first use of a keyed nonce from 20,000 execution gas to
    // 97,920 state gas. Two fresh keys therefore need 195,840 of limits.state.
    expect(HEAD_KEYED_NONCE_STATE_GAS).toBe(97_920n)
    expect(HEAD_KEYED_NONCE_STATE_GAS * 2n).toBe(195_840n)
  })
})
