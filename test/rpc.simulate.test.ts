import { describe, expect, test } from 'vitest'
import { FrameDecodeError } from '../src/errors.js'
import { parseSimulateResult } from '../src/rpc.js'
import { loadChainFixtures } from './helpers/fixtures.js'

const fixtures = loadChainFixtures()

// Hand-built, and only for shapes the node does not produce. Anything the node
// does produce is read from the captured fixtures below, so a re-capture moves
// the test with it.
const WELL_FORMED = {
  valid: true,
  prefixShape: 'SelfVerify',
  payer: '0x000000000000000000000000000000000000abcd',
  maxCost: '0x1',
  violation: null,
  gasUsed: '0x5208',
  frames: [{ gasUsed: '0x5208', succeeded: true }],
  executionStatus: 'success',
  executionError: null,
}

describe('parseSimulateResult on captured responses', () => {
  test.each(fixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const result = parseSimulateResult(fixture.simulate)
    expect(result.valid).toBe(fixture.simulate.valid)
    expect(result.maxCost).toBe(BigInt(fixture.simulate.maxCost))
    expect(result.prefixShape).toBe(fixture.simulate.prefixShape)
    expect(result.violation).toBe(fixture.simulate.violation)
  })

  test('every captured response is a structural rejection carrying a maxCost', () => {
    expect(fixtures.length).toBeGreaterThan(0)
    for (const f of fixtures) expect(BigInt(f.simulate.maxCost)).toBeGreaterThan(0n)
  })
})

describe('parseSimulateResult on a well-formed execution', () => {
  test('parses every field', () => {
    const result = parseSimulateResult(WELL_FORMED)
    expect(result.valid).toBe(true)
    expect(result.executionStatus).toBe('success')
    expect(result.gasUsed).toBe(21_000n)
    expect(result.frames).toEqual([{ gasUsed: 21_000n, succeeded: true }])
    expect(result.payer).toBe('0x000000000000000000000000000000000000ABcD')
  })
})

describe('parseSimulateResult rejects what it cannot read', () => {
  // A cast would hand the caller the string "false" typed as a boolean, and
  // `if (result.valid)` would relay a transaction the node refused.
  test('a non-boolean valid', () => {
    expect(() => parseSimulateResult({ ...WELL_FORMED, valid: 'false' })).toThrow(
      /valid must be a boolean/,
    )
  })

  // The point of the union checks: a node that grows a fifth prefix shape has
  // to say so rather than hand back a value wearing the union's type.
  test('a prefixShape outside the four known values', () => {
    expect(() =>
      parseSimulateResult({ ...WELL_FORMED, prefixShape: 'VerifyPayDeployWhatever' }),
    ).toThrow(/prefixShape must be null or one of SelfVerify/)
  })

  test('an executionStatus outside the two known values', () => {
    expect(() => parseSimulateResult({ ...WELL_FORMED, executionStatus: 'halted' })).toThrow(
      /executionStatus must be null or one of success, reverted/,
    )
  })

  // Every one of these threw a TypeError, a SyntaxError or a viem address error
  // before the field-by-field checks went in, escaping `FrameError` entirely.
  test.each([
    ['a missing maxCost', { maxCost: undefined }, /maxCost must be a hex string/],
    ['a non-hex maxCost', { maxCost: 'abc' }, /maxCost is not a hex quantity/],
    ['a non-hex gasUsed', { gasUsed: 'abc' }, /gasUsed is not a hex quantity/],
    // `BigInt` reads a prefixless string as decimal and an empty one as zero,
    // so these would each have parsed to a quietly wrong number.
    ['a decimal maxCost', { maxCost: '5208' }, /maxCost is not a hex quantity/],
    ['an empty maxCost', { maxCost: '' }, /maxCost is not a hex quantity/],
    ['a whitespace maxCost', { maxCost: '  ' }, /maxCost is not a hex quantity/],
    ['a bare 0x maxCost', { maxCost: '0x' }, /maxCost is not a hex quantity/],
    ['a decimal frame gasUsed', { frames: [{ gasUsed: '5208', succeeded: true }] },
      /frames\[0\]\.gasUsed is not a hex quantity/],
    ['a malformed payer', { payer: '0xzz' }, /payer is not an address/],
    ['frames that is not a list', { frames: 'nope' }, /frames must be null or a list/],
    [
      'a frame entry without gasUsed',
      { frames: [{ succeeded: true }] },
      /frames\[0\]\.gasUsed must be a hex string/,
    ],
    [
      'a frame entry without succeeded',
      { frames: [{ gasUsed: '0x1' }] },
      /frames\[0\]\.succeeded must be a boolean/,
    ],
    ['a non-string violation', { violation: 7 }, /violation must be a string/],
  ])('%s', (_name, patch, message) => {
    expect(() => parseSimulateResult({ ...WELL_FORMED, ...patch })).toThrow(FrameDecodeError)
    expect(() => parseSimulateResult({ ...WELL_FORMED, ...patch })).toThrow(message)
  })

  test('accepts a null or absent optional field', () => {
    expect(parseSimulateResult({ ...WELL_FORMED, prefixShape: null }).prefixShape).toBeNull()
    expect(parseSimulateResult({ valid: false, maxCost: '0x0' }).frames).toBeNull()
    expect(parseSimulateResult({ valid: false, maxCost: '0x0' }).payer).toBeNull()
  })
})
