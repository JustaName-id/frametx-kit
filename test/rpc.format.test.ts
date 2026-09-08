import { describe, expect, test } from 'vitest'
import { FrameDecodeError } from '../src/errors.js'
import {
  type RpcFrameReceiptJson,
  type RpcFrameTransaction,
  parseRpcFrameReceipt,
  parseRpcFrameTransaction,
} from '../src/rpc.js'
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

  test.each([
    ['a decimal chainId', { chainId: '8141' as `0x${string}` }, /chainId is not a hex quantity/],
    ['a non-hex nonceSeq', { nonceSeq: 'xyz' as `0x${string}` }, /nonceSeq is not a hex quantity/],
    ['an empty maxPriorityFeePerGas', { maxPriorityFeePerGas: '' as `0x${string}` }, /maxPriorityFeePerGas is not a hex quantity/],
    ['a non-hex gasLimit', { frames: [{ ...GOLDEN_RPC_JSON.frames[0]!, gasLimit: 'nope' as `0x${string}` }] }, /frames\[0\]\.gasLimit is not a hex quantity/],
    ['a malformed sender', { sender: '0xnotanaddress' as `0x${string}` }, /sender is not an address/],
    ['a malformed frame target', { frames: [{ ...GOLDEN_RPC_JSON.frames[0]!, to: '0x123' as `0x${string}` }] }, /frames\[0\]\.to is not an address/],
    ['a malformed signature signer', { signatures: [{ ...GOLDEN_RPC_JSON.signatures[0]!, signer: '0xbad' as `0x${string}` }] }, /signatures\[0\]\.signer is not an address/],
    ['a decimal recentRootReference slot', {
      recentRootReferences: [{ sourceId: '0x01' as `0x${string}`, slot: '123' as `0x${string}`, root: '0x02' as `0x${string}` }],
    }, /recentRootReferences\[0\]\.slot is not a hex quantity/],
  ])('rejects %s', (_name, patch, message) => {
    expect(() => parseRpcFrameTransaction({ ...GOLDEN_RPC_JSON, ...patch } as unknown as RpcFrameTransaction)).toThrow(FrameDecodeError)
    expect(() => parseRpcFrameTransaction({ ...GOLDEN_RPC_JSON, ...patch } as unknown as RpcFrameTransaction)).toThrow(message)
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

  test.each([
    ['a decimal status', { frameReceipts: [{ status: '1', gasUsed: '0x1', stateGasUsed: '0x0', logs: [] }] }, /frameReceipts\[0\]\.status is not a hex quantity/],
    ['a non-hex gasUsed', { frameReceipts: [{ status: '0x1', gasUsed: 'bad', stateGasUsed: '0x0', logs: [] }] }, /frameReceipts\[0\]\.gasUsed is not a hex quantity/],
    ['a non-hex stateGasUsed', { frameReceipts: [{ status: '0x1', gasUsed: '0x1', stateGasUsed: 'xyz', logs: [] }] }, /frameReceipts\[0\]\.stateGasUsed is not a hex quantity/],
    ['a malformed payer', { payer: '0xinvalid' }, /payer is not an address/],
  ])('rejects %s', (_name, patch, message) => {
    expect(() => parseRpcFrameReceipt(patch as unknown as RpcFrameReceiptJson)).toThrow(FrameDecodeError)
    expect(() => parseRpcFrameReceipt(patch as unknown as RpcFrameReceiptJson)).toThrow(message)
  })
})
