import { describe, expect, test, vi } from 'vitest'
import { type EIP1193RequestFn, createPublicClient, http, keccak256 } from 'viem'
import { frameActions } from '../src/viem.js'
import { GOLDEN_RLP, GOLDEN_RPC_JSON, GOLDEN_TX } from './fixtures/golden.js'

const GOLDEN_HASH = keccak256(GOLDEN_RLP)

function stubClient(responses: Record<string, unknown>) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (!(method in responses)) throw new Error(`unexpected method ${method}`)
    return responses[method]
  })
  // viem's request type is schema-generic; a stub needs this one cast, here only.
  return { request: request as unknown as EIP1193RequestFn }
}

describe('frameActions', () => {
  test('getFrameTransaction parses the node JSON and verifies it against the hash', async () => {
    const client = stubClient({
      eth_getTransactionByHash: { ...GOLDEN_RPC_JSON, hash: GOLDEN_HASH },
    })
    const tx = await frameActions(client).getFrameTransaction({ hash: GOLDEN_HASH })
    expect(tx).toEqual(GOLDEN_TX)
  })

  test('getFrameTransaction rejects JSON whose re-encoding does not reproduce the hash', async () => {
    const wrong = `0x${'ab'.repeat(32)}` as const
    const client = stubClient({ eth_getTransactionByHash: { ...GOLDEN_RPC_JSON, hash: wrong } })
    await expect(frameActions(client).getFrameTransaction({ hash: wrong })).rejects.toThrow(
      /layout has moved/,
    )
  })

  test('getFrameTransaction succeeds with an uppercased hash', async () => {
    const uppercased = `0x${GOLDEN_HASH.slice(2).toUpperCase()}` as `0x${string}`
    const client = stubClient({
      eth_getTransactionByHash: { ...GOLDEN_RPC_JSON, hash: uppercased },
    })
    const tx = await frameActions(client).getFrameTransaction({ hash: uppercased })
    expect(tx).toEqual(GOLDEN_TX)
  })

  test('getFrameTransaction rejects a non-frame transaction', async () => {
    const client = stubClient({ eth_getTransactionByHash: { ...GOLDEN_RPC_JSON, type: '0x2', hash: GOLDEN_HASH } })
    await expect(frameActions(client).getFrameTransaction({ hash: GOLDEN_HASH })).rejects.toThrow(
      /not a frame transaction/,
    )
  })

  test('getFrameTransactionReceipt keeps skipped distinct from reverted', async () => {
    const client = stubClient({
      eth_getTransactionReceipt: {
        payer: null,
        frameReceipts: [
          { status: '0x2', gasUsed: '0x0', stateGasUsed: '0x0', logs: [] },
        ],
      },
    })
    const receipt = await frameActions(client).getFrameTransactionReceipt({
      hash: `0x${'ab'.repeat(32)}`,
    })
    expect(receipt.frameReceipts[0]!.status).toBe('skipped')
  })

  test('estimateFrameGas prices under the requested rule set', () => {
    const actions = frameActions(stubClient({}))
    expect(actions.estimateFrameGas({ transaction: GOLDEN_TX }).maxGas).toBe(77_974n)
  })

  test('composes with client.extend on a real viem client', () => {
    // No network: this is a typecheck of the extension surface plus a shape check.
    // A hand-written structural `request` type fails here; see CONTRIBUTING.md's
    // last wire-format trap and `FrameRpcClient` in src/rpc.ts.
    const client = createPublicClient({ transport: http('http://127.0.0.1:1') }).extend(
      frameActions,
    )
    expect(typeof client.getFrameTransaction).toBe('function')
    expect(client.estimateFrameGas({ transaction: GOLDEN_TX }).maxGas).toBe(77_974n)
  })
})
