import { describe, expect, test, vi } from 'vitest'
import { type EIP1193RequestFn, keccak256 } from 'viem'
import { sendRawFrameTransaction } from '../src/rpc.js'
import { GOLDEN_RLP } from './fixtures/golden.js'

const GOLDEN_HASH = keccak256(GOLDEN_RLP)

function stubClient(handler: (args: { method: string; params?: unknown }) => unknown) {
  const request = vi.fn(async (args: { method: string; params?: unknown }) => handler(args))
  // viem's request type is schema-generic; a stub needs this one cast, here only.
  return { client: { request: request as unknown as EIP1193RequestFn }, request }
}

describe('sendRawFrameTransaction', () => {
  test('posts the bytes to eth_sendRawTransaction and returns the hash', async () => {
    const { client, request } = stubClient(({ method }) => {
      if (method === 'eth_sendRawTransaction') return GOLDEN_HASH
      throw new Error(`unexpected method ${method}`)
    })
    const hash = await sendRawFrameTransaction(client, GOLDEN_RLP)
    expect(hash).toBe(GOLDEN_HASH)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![0]).toEqual({
      method: 'eth_sendRawTransaction',
      params: [GOLDEN_RLP],
    })
  })

  test('accepts an uppercased hash from the node and returns it lowercased', async () => {
    const uppercased = `0x${GOLDEN_HASH.slice(2).toUpperCase()}`
    const { client } = stubClient(() => uppercased)
    expect(await sendRawFrameTransaction(client, GOLDEN_RLP)).toBe(GOLDEN_HASH)
  })

  test('rejects a hash that is not keccak256 of the bytes it sent', async () => {
    const wrong = `0x${'ab'.repeat(32)}`
    const { client } = stubClient(() => wrong)
    await expect(sendRawFrameTransaction(client, GOLDEN_RLP)).rejects.toThrow(
      /node returned .* for bytes hashing to/,
    )
  })

  test('rejects a non-hash answer instead of returning it', async () => {
    const { client } = stubClient(() => null)
    await expect(sendRawFrameTransaction(client, GOLDEN_RLP)).rejects.toThrow(
      /must be a 32-byte hash/,
    )
  })

  test('rejects bytes that do not start with the frame type byte 0x06', async () => {
    const { client, request } = stubClient(() => GOLDEN_HASH)
    await expect(sendRawFrameTransaction(client, '0x02c0')).rejects.toThrow(
      /not a frame transaction/,
    )
    expect(request).not.toHaveBeenCalled()
  })

  test('propagates the node error unchanged', async () => {
    const { client } = stubClient(() => {
      throw new Error('nonce too low')
    })
    await expect(sendRawFrameTransaction(client, GOLDEN_RLP)).rejects.toThrow('nonce too low')
  })
})
