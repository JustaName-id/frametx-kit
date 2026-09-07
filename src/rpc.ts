import { type Address, type EIP1193RequestFn, type Hex, getAddress } from 'viem'
import { FrameDecodeError } from './errors.js'
import type {
  Frame,
  FrameMode,
  FrameSignature,
  FrameTransaction,
  RecentRootReference,
  SigScheme,
} from './types.js'

export type RpcFrameTransaction = {
  /** `'0x6'` — minimal hex, one digit. */
  type: string
  /** Present on `eth_getTransactionByHash` and hydrated blocks; absent on hand-written fixtures. */
  hash?: Hex
  chainId: Hex
  nonceKeys: readonly Hex[]
  nonceSeq: Hex
  sender: Address
  frames: readonly {
    mode: Hex
    flags: Hex
    /** The node calls this `to`, not `target`. */
    to: Address | null
    gasLimit: Hex
    stateLimit: Hex
    value: Hex
    data: Hex
  }[]
  signatures: readonly {
    scheme: Hex
    signer: Address | null
    msg: Hex
    signature: Hex
  }[]
  maxPriorityFeePerGas: Hex
  maxFeePerGas: Hex
  maxFeePerBlobGas: Hex
  blobVersionedHashes: readonly Hex[]
  recentRootReferences: readonly { sourceId: Hex; slot: Hex; root: Hex }[]
}

/** EIP-8141 frame receipt status: 0 failure, 1 success, 2 skipped (atomic-batch failure). */
export type FrameStatus = 'failure' | 'success' | 'skipped'

export type FrameReceipt = {
  payer: Address | null
  frameReceipts: {
    status: FrameStatus
    gasUsed: bigint
    /** EIP-8037 state gas, after every cross-frame refill has been applied. */
    stateGasUsed: bigint
    logs: unknown[]
  }[]
}

export type RpcFrameReceiptJson = {
  payer?: Address | null
  frameReceipts?: readonly {
    status: Hex
    gasUsed: Hex
    stateGasUsed: Hex
    logs: readonly unknown[]
  }[]
}

export type SimulateFrameTransactionResult = {
  valid: boolean
  prefixShape:
    | 'SelfVerify'
    | 'DeploySelfVerify'
    | 'OnlyVerifyPay'
    | 'DeployOnlyVerifyPay'
    | null
  payer: Address | null
  maxCost: bigint
  violation: string | null
  gasUsed: bigint | null
  frames: { gasUsed: bigint; succeeded: boolean }[] | null
  executionStatus: 'success' | 'reverted' | null
  executionError: string | null
}

function toMode(value: Hex): FrameMode {
  const mode = Number(BigInt(value))
  if (mode !== 0 && mode !== 1 && mode !== 2)
    throw new FrameDecodeError(`unsupported frame mode ${mode}`)
  return mode
}

function toScheme(value: Hex): SigScheme {
  const scheme = Number(BigInt(value))
  if (scheme !== 0 && scheme !== 1 && scheme !== 2)
    throw new FrameDecodeError(`unsupported signature scheme ${scheme}`)
  return scheme
}

const STATUS: Record<number, FrameStatus> = {
  0: 'failure',
  1: 'success',
  2: 'skipped',
}

/** Parse the node's decoded JSON view. Oracle 2 diffs this against `decodeFrameTx`. */
export function parseRpcFrameTransaction(json: RpcFrameTransaction): FrameTransaction {
  const frames: Frame[] = json.frames.map((f) => ({
    mode: toMode(f.mode),
    flags: Number(BigInt(f.flags)),
    target: f.to === null ? null : getAddress(f.to),
    limits: { execution: BigInt(f.gasLimit), state: BigInt(f.stateLimit) },
    value: BigInt(f.value),
    data: f.data,
  }))

  const signatures: FrameSignature[] = json.signatures.map((s) => ({
    scheme: toScheme(s.scheme),
    signer: s.signer === null ? null : getAddress(s.signer),
    msg: s.msg,
    signature: s.signature,
  }))

  const recentRootReferences: RecentRootReference[] = json.recentRootReferences.map(
    (r) => ({ sourceId: r.sourceId, slot: BigInt(r.slot), root: r.root }),
  )

  return {
    chainId: BigInt(json.chainId),
    nonceKeys: json.nonceKeys.map((k) => BigInt(k)),
    nonceSeq: BigInt(json.nonceSeq),
    sender: getAddress(json.sender),
    frames,
    signatures,
    maxPriorityFeePerGas: BigInt(json.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(json.maxFeePerGas),
    maxFeePerBlobGas: BigInt(json.maxFeePerBlobGas),
    blobVersionedHashes: [...json.blobVersionedHashes],
    recentRootReferences,
  }
}

/**
 * Parse the frame-specific parts of a receipt.
 *
 * `status` is three-valued. Collapsing 2 into "reverted" is wrong: a skipped
 * frame never executed and its gas was refunded. This is the defect in viem
 * PR 4486.
 */
export function parseRpcFrameReceipt(json: RpcFrameReceiptJson): FrameReceipt {
  return {
    payer: json.payer ? getAddress(json.payer) : null,
    frameReceipts: (json.frameReceipts ?? []).map((f) => {
      const code = Number(BigInt(f.status))
      const status = STATUS[code]
      if (status === undefined)
        throw new FrameDecodeError(`unknown frame receipt status ${code}`)
      return {
        status,
        gasUsed: BigInt(f.gasUsed),
        stateGasUsed: BigInt(f.stateGasUsed),
        logs: [...f.logs],
      }
    }),
  }
}

/**
 * Anything with viem's `request`. viem types `request` against the client's RPC
 * schema, so a hand-written structural type — `(args: { method: string; ... })`
 * — is NOT satisfied by a real client and `client.extend(frameActions)` would
 * not typecheck. `EIP1193RequestFn` with no schema is, and it accepts the
 * `ethrex_` namespace. A test stub needs one cast to it (see Task 11).
 */
export type FrameRpcClient = { request: EIP1193RequestFn }

/**
 * `ethrex_simulateFrameTransaction`: dry-run the validation prefix and a full
 * multi-frame execution without submitting. Only `'latest'` works on the public
 * node: historical state is pruned (`state root missing for block N`).
 *
 * `valid: true` is NECESSARY but not SUFFICIENT for admission — the gates shared
 * with every other transaction type, and the per-sender pending-frame rule, are
 * not replayed.
 */
export async function simulateFrameTransaction(
  client: FrameRpcClient,
  raw: Hex,
  block: string = 'latest',
): Promise<SimulateFrameTransactionResult> {
  const result = (await client.request({
    method: 'ethrex_simulateFrameTransaction',
    params: [raw, block],
  })) as Record<string, unknown>

  return {
    valid: result.valid as boolean,
    prefixShape: (result.prefixShape ?? null) as SimulateFrameTransactionResult['prefixShape'],
    payer: result.payer ? getAddress(result.payer as Address) : null,
    maxCost: BigInt(result.maxCost as Hex),
    violation: (result.violation ?? null) as string | null,
    gasUsed: result.gasUsed ? BigInt(result.gasUsed as Hex) : null,
    frames: result.frames
      ? (result.frames as { gasUsed: Hex; succeeded: boolean }[]).map((f) => ({
          gasUsed: BigInt(f.gasUsed),
          succeeded: f.succeeded,
        }))
      : null,
    executionStatus: (result.executionStatus ??
      null) as SimulateFrameTransactionResult['executionStatus'],
    executionError: (result.executionError ?? null) as string | null,
  }
}
