import { type Hex, keccak256 } from 'viem'
import { encodeFrameTx } from './envelope.js'
import { FrameDecodeError, FrameEncodeError, FrameTimeoutError } from './errors.js'
import { type FrameGas, frameTxGas } from './gas.js'
import {
  type FrameReceipt,
  type FrameRpcClient,
  type RpcFrameReceiptJson,
  type RpcFrameTransaction,
  type SimulateFrameTransactionResult,
  parseRpcFrameReceipt,
  parseRpcFrameTransaction,
  sendRawFrameTransaction,
  simulateFrameTransaction,
} from './rpc.js'
import { assertValidFrameTx } from './signatures.js'
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

    /**
     * Poll `eth_getTransactionReceipt` until the transaction is mined, then
     * parse the frame receipts. viem's own `waitForTransactionReceipt` would
     * hand back a receipt whose frame statuses are collapsed to
     * success/reverted (viem PR 4486); this one keeps `'skipped'` distinct.
     *
     * A receipt with `frameReceipts: []` is still a receipt: the node omits the
     * field on non-frame receipts, and the caller asked about a hash, not a type.
     */
    async waitForFrameTransactionReceipt({
      hash,
      pollingInterval = 1_000,
      timeout = 60_000,
    }: {
      hash: Hex
      pollingInterval?: number
      timeout?: number
    }): Promise<FrameReceipt> {
      if (!(pollingInterval > 0))
        throw new FrameEncodeError(`pollingInterval must be positive, got ${pollingInterval}`)
      const deadline = Date.now() + timeout
      for (;;) {
        const receipt = (await client.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        })) as RpcFrameReceiptJson | null
        if (receipt !== null) return parseRpcFrameReceipt(receipt)
        if (Date.now() >= deadline)
          throw new FrameTimeoutError(`no receipt for ${hash} after ${timeout}ms`)
        await new Promise((resolve) => setTimeout(resolve, pollingInterval))
      }
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

    /**
     * Submit a frame transaction.
     *
     * The `transaction` form is the strict path from CONTRIBUTING.md:
     * `assertValidFrameTx` then `encodeFrameTx`, then `eth_sendRawTransaction`.
     * Nothing is sent if validation fails. The `raw` form is for bytes you
     * assembled and checked yourself (multi-signer, P256, ARBITRARY).
     *
     * Admission is the node's call, not ours. A transaction can pass every
     * check here and still be rejected — most commonly because the sender is a
     * plain EOA and the VERIFY prefix has no code to call APPROVE. Run
     * `simulateFrameTransaction` first if you want that answer before spending.
     *
     * `async` rather than a plain function returning a promise: both
     * `assertValidFrameTx` and `encodeFrameTx` throw synchronously, and a
     * declared `Promise<Hex>` that throws before it returns a promise cannot be
     * caught with `.catch()`. Every failure here reaches the caller as a
     * rejection instead.
     */
    async sendFrameTransaction(
      args: { transaction: FrameTransaction } | { raw: Hex },
    ): Promise<Hex> {
      if ('raw' in args) return sendRawFrameTransaction(client, args.raw)
      assertValidFrameTx(args.transaction)
      return sendRawFrameTransaction(client, encodeFrameTx(args.transaction))
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
