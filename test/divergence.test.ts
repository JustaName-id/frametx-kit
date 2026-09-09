import { describe, expect, test } from 'vitest'
import { size, sliceHex } from 'viem'
import {
  HEAD_KEYED_NONCE_STATE_GAS,
  HEAD_RECENT_ROOT_VERIFIER,
  HEAD_REFERENCE_BYTES,
  compareRuleSets,
  toHeadShape,
} from '../src/divergence.js'
import { frameTxGas } from '../src/gas.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const REF_A = {
  sourceId: `0x${'11'.repeat(32)}`,
  slot: 0xaf1n,
  root: `0x${'22'.repeat(32)}`,
} as const

const REF_B = {
  sourceId: `0x${'33'.repeat(32)}`,
  slot: 0xaf6n,
  root: `0x${'44'.repeat(32)}`,
} as const

const TWO_REFERENCE_TX = { ...GOLDEN_TX, recentRootReferences: [REF_A, REF_B] }

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

describe('toHeadShape', () => {
  test('leaves a transaction that carries no reference untouched', () => {
    expect(toHeadShape(GOLDEN_TX)).toBe(GOLDEN_TX)
  })

  test('empties the envelope field and prepends one VERIFY frame', () => {
    const head = toHeadShape(TWO_REFERENCE_TX)
    expect(head.recentRootReferences).toEqual([])
    expect(head.frames.length).toBe(GOLDEN_TX.frames.length + 1)
    expect(head.frames.slice(1)).toEqual(GOLDEN_TX.frames)
  })

  // upstream eip-8272.md @ 824cbc0b0, §"Recent root verifier frame": the shape
  // is normative — mode VERIFY, target RECENT_ROOT_ADDRESS, flags 0, value 0,
  // limits.state 0 — and the data is n tuples with no selector or length prefix.
  test('the synthetic frame matches the EIP-8272 recent-root-verifier-frame shape', () => {
    const verify = toHeadShape(TWO_REFERENCE_TX).frames[0]!
    expect(verify.mode).toBe(1) // VERIFY
    expect(verify.target).toBe(HEAD_RECENT_ROOT_VERIFIER)
    expect(verify.flags).toBe(0)
    expect(verify.value).toBe(0n)
    expect(verify.limits.state).toBe(0n)
    // RECENT_ROOT_TUPLE_BYTES <= len(data), len(data) % RECENT_ROOT_TUPLE_BYTES == 0
    expect(size(verify.data)).toBeGreaterThanOrEqual(HEAD_REFERENCE_BYTES)
    expect(size(verify.data) % HEAD_REFERENCE_BYTES).toBe(0)
  })

  // limits.execution is the one field the spec does NOT pin — it falls out of
  // the STATICCALL and one SLOAD per tuple — so zero is a deliberate floor.
  test('the synthetic frame claims no execution budget: a floor, not a figure', () => {
    expect(toHeadShape(TWO_REFERENCE_TX).frames[0]!.limits.execution).toBe(0n)
  })

  test('both references pack into one frame, 72 bytes each', () => {
    const data = toHeadShape(TWO_REFERENCE_TX).frames[0]!.data
    expect(size(data)).toBe(2 * HEAD_REFERENCE_BYTES)
  })

  // eip-8272.md §"Validation operation": source_id: bytes32, slot: uint64_be,
  // root: bytes32 — concatenated, big-endian slot, in that order.
  test('each reference packs as source_id || slot || root', () => {
    const data = toHeadShape(TWO_REFERENCE_TX).frames[0]!.data
    for (const [i, ref] of [REF_A, REF_B].entries()) {
      const at = i * HEAD_REFERENCE_BYTES
      expect(sliceHex(data, at, at + 32)).toBe(ref.sourceId)
      expect(BigInt(sliceHex(data, at + 32, at + 40))).toBe(ref.slot)
      expect(sliceHex(data, at + 40, at + 72)).toBe(ref.root)
    }
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
