import { describe, expect, test } from 'vitest'
import { parseRpcFrameReceipt, parseRpcFrameTransaction } from '../src/rpc.js'
import { GOLDEN_RPC_JSON, GOLDEN_TX } from './fixtures/golden.js'

describe('parseRpcFrameTransaction', () => {
  test('parses the node JSON into the same transaction as the raw decoder', () => {
    // The JSON is lowercase, as the node serves it; the parser checksums.
    expect(parseRpcFrameTransaction(GOLDEN_RPC_JSON)).toEqual(GOLDEN_TX)
  })

  test('maps the JSON field `to` onto `target`', () => {
    expect(parseRpcFrameTransaction(GOLDEN_RPC_JSON).frames[0]!.target).toBeNull()
    expect(parseRpcFrameTransaction(GOLDEN_RPC_JSON).frames[1]!.target).toBe(
      '0x0000000000000000000000000000000000001234',
    )
  })
})

describe('parseRpcFrameReceipt', () => {
  test('keeps all three frame statuses distinct', () => {
    const receipt = parseRpcFrameReceipt({
      payer: '0x000000000000000000000000000000000000abcd',
      frameReceipts: [
        { status: '0x0', gasUsed: '0x1', stateGasUsed: '0x0', logs: [] },
        { status: '0x1', gasUsed: '0x2', stateGasUsed: '0x3', logs: [] },
        { status: '0x2', gasUsed: '0x0', stateGasUsed: '0x0', logs: [] },
      ],
    })
    expect(receipt.frameReceipts.map((f) => f.status)).toEqual([
      'failure',
      'success',
      'skipped',
    ])
  })

  test('preserves stateGasUsed', () => {
    const receipt = parseRpcFrameReceipt({
      payer: null,
      frameReceipts: [{ status: '0x1', gasUsed: '0x2', stateGasUsed: '0x3', logs: [] }],
    })
    expect(receipt.frameReceipts[0]!.stateGasUsed).toBe(3n)
  })

  test('a receipt with no frameReceipts yields an empty list', () => {
    // The node omits `payer` and `frameReceipts` entirely on non-frame receipts
    // (`skip_serializing_if = "Option::is_none"`), so both are optional.
    expect(parseRpcFrameReceipt({}).frameReceipts).toEqual([])
  })
})
