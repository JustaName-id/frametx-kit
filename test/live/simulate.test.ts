import { describe, expect, test } from 'vitest'
import { http, createPublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFrameTx } from '../../src/envelope.js'
import { frameTxMaxCost } from '../../src/gas.js'
import { parseRpcFrameTransaction, simulateFrameTransaction } from '../../src/rpc.js'
import { signFrameTx } from '../../src/signatures.js'
import type { FrameTransaction } from '../../src/types.js'
import { loadChainFixtures } from '../helpers/fixtures.js'

const RPC_URL = 'https://rpc1.privacy.ethrex.xyz'
const CHAIN_ID = 8141n
const GENESIS_HASH = '0x7ca0f7358d127dc4a68983050eb88837a5f384225254d1b009fa87fbcd0f2332'

// A throwaway key. It holds no funds and never will; simulation does not spend.
const THROWAWAY_KEY = `0x${'42'.repeat(32)}` as const

const live = process.env.FRAMES_LIVE === '1'

describe.skipIf(!live)('ethrex_simulateFrameTransaction', () => {
  const client = createPublicClient({ transport: http(RPC_URL) })
  const account = privateKeyToAccount(THROWAWAY_KEY)

  test('the node reports our chain id and the third genesis', async () => {
    expect(BigInt(await client.getChainId())).toBe(CHAIN_ID)
    const genesis = await client.getBlock({ blockNumber: 0n })
    expect(genesis.hash).toBe(GENESIS_HASH)
  })

  test('a throwaway-signed SelfVerify transaction is decoded, authenticated and priced', async () => {
    const tx: FrameTransaction = {
      chainId: CHAIN_ID,
      nonceKeys: [0n],
      nonceSeq: 0n,
      sender: account.address,
      frames: [
        {
          mode: 1, // VERIFY: the only mode that can open a recognized prefix
          flags: 0x3, // APPROVE_EXECUTION | APPROVE_PAYMENT → SelfVerify
          target: null,
          limits: { execution: 21_000n, state: 0n },
          value: 0n,
          data: '0x',
        },
      ],
      signatures: [{ scheme: 1, signer: null, msg: '0x', signature: '0x' }],
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
      maxFeePerBlobGas: 0n,
      blobVersionedHashes: [],
      recentRootReferences: [],
    }

    const signed = await signFrameTx(tx, THROWAWAY_KEY)
    const result = await simulateFrameTransaction(client, encodeFrameTx(signed))

    // maxCost is a pure function of the fields and is present on every path.
    // Proves the node computed the same max_gas from our bytes as we did.
    expect(result.maxCost).toBe(frameTxMaxCost(signed, 0n, 'chain'))

    // The prefix shape is derived AFTER signature authentication, so a non-null
    // shape proves the node decoded our envelope AND accepted our signature.
    expect(result.prefixShape).toBe('SelfVerify')

    // A throwaway EOA has no code to call APPROVE, so the prefix cannot pass.
    // Observed 2026-09-06: `valid: false`, `violation: "validation prefix frame reverted"`.
    expect(result.valid).toBe(false)
    expect(result.violation).toMatch(/prefix/)
  })

  test('a captured transaction re-encoded from its JSON is authenticated by the node', async () => {
    const fixture = loadChainFixtures()[0]
    if (fixture === undefined) return
    const tx = parseRpcFrameTransaction(fixture.tx)
    const result = await simulateFrameTransaction(client, encodeFrameTx(tx))
    // It cannot be valid any more (its nonce is spent or its root expired), but it
    // must get past signature authentication, and the node's maxCost is stable.
    expect(result.violation ?? '').not.toMatch(/does not authenticate/)
    expect(result.maxCost).toBe(BigInt(fixture.simulate.maxCost))
  })

  test('a malformed envelope is rejected by the node, not silently accepted', async () => {
    // Observed: JSON-RPC error -32000 "Invalid params: Error decoding field 'chain_id'".
    await expect(simulateFrameTransaction(client, '0x06c0')).rejects.toThrow(
      /decoding|Invalid params/,
    )
  })
})
