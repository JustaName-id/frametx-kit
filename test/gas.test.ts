import { describe, expect, test } from 'vitest'
import { frameTxGas, frameTxMaxCost } from '../src/gas.js'
import { GOLDEN_TX } from './fixtures/golden.js'

describe('frameTxGas on the golden vector', () => {
  const gas = frameTxGas(GOLDEN_TX, 'chain')

  test('mandatory gas', () => expect(gas.mandatoryGas).toBe(15_750n))
  test('billed byte count', () => expect(gas.billedBytes).toBe(90n))
  test('data cost', () => expect(gas.dataCost).toBe(1_224n))
  test('recent-root reference gas is zero with no references', () =>
    expect(gas.recentRootReferenceGas).toBe(0n))
  test('intrinsic gas', () => expect(gas.intrinsicGas).toBe(16_974n))
  test('state gas limit', () => expect(gas.stateGasLimit).toBe(0n))
  test('standard gas limit', () => expect(gas.standardGasLimit).toBe(77_974n))
  test('calldata tokens', () => expect(gas.calldataTokens).toBe(360n))
  test('calldata floor total', () => expect(gas.calldataFloorTotal).toBe(21_510n))
  test('max gas takes the standard branch', () => expect(gas.maxGas).toBe(77_974n))
})

describe('frameTxMaxCost', () => {
  test('is maxGas * maxFeePerGas with no blobs', () => {
    expect(frameTxMaxCost(GOLDEN_TX, 0n, 'chain')).toBe(2_339_220_000_000_000n)
  })

  test('adds the blob term at the base rate', () => {
    const tx = { ...GOLDEN_TX, blobVersionedHashes: [`0x${'ab'.repeat(32)}` as const] }
    const gas = frameTxGas(tx, 'chain')
    expect(frameTxMaxCost(tx, 7n, 'chain')).toBe(
      gas.maxGas * tx.maxFeePerGas + 131_072n * 7n,
    )
  })
})

describe('the calldata floor branch', () => {
  test('binds when declared execution gas is small relative to data', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, limits: { execution: 1n, state: 0n },
          data: `0x${'ff'.repeat(2000)}` as const },
      ],
      signatures: [],
    }
    const gas = frameTxGas(tx, 'chain')
    expect(gas.maxGas).toBe(gas.calldataFloorTotal + gas.stateGasLimit)
    expect(gas.maxGas).toBeGreaterThan(gas.standardGasLimit)
  })

  test('state gas is added on top of the floor, never absorbed by it', () => {
    const base = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, limits: { execution: 1n, state: 0n },
          data: `0x${'ff'.repeat(2000)}` as const },
      ],
      signatures: [],
    }
    const withState = {
      ...base,
      frames: [{ ...base.frames[0]!, limits: { execution: 1n, state: 50_000n } }],
    }
    expect(frameTxGas(withState, 'chain').maxGas).toBe(
      frameTxGas(base, 'chain').maxGas + 50_000n,
    )
  })
})

describe('recent-root references', () => {
  test('charge 2400 + 2002 per reference and bill their RLP bytes', () => {
    const tx = {
      ...GOLDEN_TX,
      recentRootReferences: [
        { sourceId: `0x${'11'.repeat(32)}` as const, slot: 100n, root: `0x${'22'.repeat(32)}` as const },
      ],
    }
    const gas = frameTxGas(tx, 'chain')
    expect(gas.recentRootReferenceGas).toBe(2_400n + 2_002n)
    expect(gas.billedBytes).toBeGreaterThan(90n)
  })

  test('an empty reference list bills no bytes at all', () => {
    // recentRootCalldata must be '0x', NOT toRlp([]) === '0xc0'
    expect(frameTxGas(GOLDEN_TX, 'chain').billedBytes).toBe(90n)
  })
})

describe('rule sets', () => {
  test("'head' prices identically to 'pins' — the head change is execution-time state gas", () => {
    expect(frameTxGas(GOLDEN_TX, 'head')).toEqual(frameTxGas(GOLDEN_TX, 'pins'))
  })

  test("'head' throws for a transaction carrying a recent-root reference", () => {
    const tx = {
      ...GOLDEN_TX,
      recentRootReferences: [
        { sourceId: `0x${'11'.repeat(32)}` as const, slot: 100n, root: `0x${'22'.repeat(32)}` as const },
      ],
    }
    expect(() => frameTxGas(tx, 'head')).toThrow(/no head-shaped equivalent/)
  })
})
