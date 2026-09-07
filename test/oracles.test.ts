import { describe, expect, test } from 'vitest'
import { keccak256 } from 'viem'
import { decodeFrameTx, encodeFrameTx } from '../src/envelope.js'
import { frameTxGas, frameTxMaxCost } from '../src/gas.js'
import { compareRuleSets } from '../src/divergence.js'
import { parseRpcFrameReceipt, parseRpcFrameTransaction } from '../src/rpc.js'
import { recoverFrameSigner, resolveSigner } from '../src/signatures.js'
import { loadChainFixtures } from './helpers/fixtures.js'

const fixtures = loadChainFixtures()

describe('captured fixtures', () => {
  test('at least one fixture is present', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  test('every fixture was captured against the third genesis', () => {
    for (const f of fixtures)
      expect(f.meta.genesisHash).toBe(
        '0x7ca0f7358d127dc4a68983050eb88837a5f384225254d1b009fa87fbcd0f2332',
      )
  })
})

describe.each(fixtures)('$name', (fixture) => {
  const tx = parseRpcFrameTransaction(fixture.tx)
  const raw = encodeFrameTx(tx)

  // Oracle 2: absolute layout. The transaction hash is keccak256 of the canonical
  // bytes, so reproducing it from the node's decoded JSON pins every byte of the
  // envelope — nesting included. A field-by-field diff of two decoders could not
  // see a mis-nesting they both made; the hash can.
  test('re-encoding the node JSON reproduces the transaction hash', () => {
    expect(keccak256(raw)).toBe(fixture.tx.hash)
  })

  // Oracle 2, decoder side: our decoder over those bytes agrees with the node's
  // decoder over the same bytes.
  test('decodes to the same transaction the node reports', () => {
    expect(decodeFrameTx(raw)).toEqual(tx)
  })

  // The node ran signature authentication over our bytes and got past it, i.e.
  // our sig_hash over a REAL signature equals the node's. Recorded at capture.
  test('the node authenticated our re-encoding', () => {
    expect(fixture.simulate.violation ?? '').not.toMatch(/does not authenticate/)
  })

  // Oracle 3: recovery. The signer is often NOT the sender on this chain — the
  // shielded pool's spends have the pool as sender and an EOA as signer — so the
  // comparison is against the resolved signer, not `sender`.
  test('every empty-msg secp256k1 signature recovers to its resolved signer', async () => {
    for (const [i, sig] of tx.signatures.entries()) {
      if (sig.scheme !== 1 || sig.msg !== '0x') continue
      expect(await recoverFrameSigner(tx, i)).toBe(resolveSigner(tx, i))
    }
  })

  // Oracle 3: the receipt parses, one entry per frame, three-valued status intact.
  test('the receipt parses with one entry per frame', () => {
    const receipt = parseRpcFrameReceipt(fixture.receipt)
    expect(receipt.frameReceipts.length).toBe(tx.frames.length)
  })

  // Oracle 3: max gas. The node computed `maxCost` from OUR bytes; 'chain' must
  // reproduce it exactly. The blob term needs the block's blob base fee, which
  // the fixture does not carry, so blob-carrying transactions are skipped here.
  test("'chain' reproduces the node's maxCost", () => {
    if (tx.blobVersionedHashes.length > 0) return
    expect(frameTxMaxCost(tx, 0n, 'chain')).toBe(BigInt(fixture.simulate.maxCost))
  })

  // Oracle 3: the receipt reconciles. Observed with a zero delta on every live
  // transaction checked: gasUsed = intrinsic + Σ execution + Σ state. Four of
  // the five captured fixtures (block 2782, 2787, 2792, 42241) take the
  // standard branch; the fifth, 0xe936e39d…25fb1 at block 42086, takes the
  // EIP-7623 calldata-floor branch — standard 26246, floored 27382, actual
  // receipt gasUsed 27382 — so both arms are exercised on live data.
  test('receipt.gasUsed = intrinsic + Σ frame gasUsed + Σ frame stateGasUsed', () => {
    const receipt = parseRpcFrameReceipt(fixture.receipt)
    const gas = frameTxGas(tx, 'chain')
    const execution = receipt.frameReceipts.reduce((acc, f) => acc + f.gasUsed, 0n)
    const state = receipt.frameReceipts.reduce((acc, f) => acc + f.stateGasUsed, 0n)
    const standard = gas.intrinsicGas + execution + state
    const floored = gas.calldataFloorTotal + state
    expect(BigInt(fixture.receipt.gasUsed)).toBe(standard > floored ? standard : floored)
  })

  // The divergence survey. Any divergence must be one the ledger explains.
  test('chain-vs-pins divergences are only ever valueTransferCost-rooted', () => {
    const divergences = compareRuleSets(tx, 'chain', 'pins')
    if (divergences.length === 0) return
    const root = divergences.find((d) => d.term === 'valueTransferCost')
    expect(root, `unexplained divergence in ${fixture.name}: ${JSON.stringify(
      divergences.map((d) => d.term),
    )}`).toBeDefined()
    expect(root!.delta % 6_000n).toBe(0n)
  })
})
