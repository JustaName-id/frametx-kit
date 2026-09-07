import { type Hex, keccak256 } from 'viem'
import { encodeFrameTx } from './envelope.js'
import { FrameDecodeError } from './errors.js'
import { type FrameGas, frameTxGas } from './gas.js'
import {
  type FrameReceipt,
  type FrameRpcClient,
  type RpcFrameReceiptJson,
  type RpcFrameTransaction,
  type SimulateFrameTransactionResult,
  parseRpcFrameReceipt,
  parseRpcFrameTransaction,
  simulateFrameTransaction,
} from './rpc.js'
import type { FrameTransaction, RuleSet } from './types.js'

/**
 * viem extension: `client.extend(frameActions)`.
 *
 * Deliberately an out-of-tree extension rather than a patch to viem core. These
 * EIPs are pinned drafts that move weekly, and this chain's envelope is a
 * composition none of them specifies.
 *
 * The parameter is `FrameRpcClient` — `{ request: EIP1193RequestFn }` — because
 * viem types `request` against the client's RPC schema and a hand-written
 * structural type is not satisfied by a real client (see the last trap in
 * CONTRIBUTING.md's "Traps specific to this wire format").
 */
export function frameActions(client: FrameRpcClient) {
  return {
    /**
     * Fetch and decode a frame transaction.
     *
     * The public endpoint serves no raw bytes, so this reads the node's decoded
     * JSON, re-encodes it, and checks the result against the transaction hash
     * before returning — the same pin Oracle 2 in `test/oracles.test.ts` applies
     * to every captured fixture.
     * A hash mismatch means the envelope layout has moved under us.
     */
    async getFrameTransaction({ hash }: { hash: Hex }): Promise<FrameTransaction> {
      const json = (await client.request({
        method: 'eth_getTransactionByHash',
        params: [hash],
      })) as (RpcFrameTransaction & { hash: Hex }) | null
      if (json === null) throw new FrameDecodeError(`transaction ${hash} not found`)
      if (json.type !== '0x6')
        throw new FrameDecodeError(
          `transaction ${hash} is type ${json.type}, not a frame transaction`,
        )
      const tx = parseRpcFrameTransaction(json)
      const reencoded = keccak256(encodeFrameTx(tx))
      if (reencoded.toLowerCase() !== hash.toLowerCase())
        throw new FrameDecodeError(
          `re-encoding ${hash} produced ${reencoded}; the envelope layout has moved`,
        )
      return tx
    },

    async getFrameTransactionReceipt({ hash }: { hash: Hex }): Promise<FrameReceipt> {
      const receipt = (await client.request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      })) as RpcFrameReceiptJson | null
      if (receipt === null) throw new FrameDecodeError(`receipt for ${hash} not found`)
      return parseRpcFrameReceipt(receipt)
    },

    simulateFrameTransaction({
      raw,
      block = 'latest',
    }: {
      raw: Hex
      block?: string
    }): Promise<SimulateFrameTransactionResult> {
      return simulateFrameTransaction(client, raw, block)
    },

    estimateFrameGas({
      transaction,
      rules = 'chain',
    }: {
      transaction: FrameTransaction
      rules?: RuleSet
    }): FrameGas {
      return frameTxGas(transaction, rules)
    },
  }
}
