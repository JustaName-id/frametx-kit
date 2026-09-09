import { type Address, type EIP1193RequestFn, type Hex, getAddress, keccak256 } from 'viem'
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

const PREFIX_SHAPES = [
  'SelfVerify',
  'DeploySelfVerify',
  'OnlyVerifyPay',
  'DeployOnlyVerifyPay',
] as const

const EXECUTION_STATUSES = ['success', 'reverted'] as const

type PrefixShape = (typeof PREFIX_SHAPES)[number]
type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

export type SimulateFrameTransactionResult = {
  valid: boolean
  prefixShape: PrefixShape | null
  payer: Address | null
  maxCost: bigint
  violation: string | null
  gasUsed: bigint | null
  frames: { gasUsed: bigint; succeeded: boolean }[] | null
  executionStatus: ExecutionStatus | null
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
 * `ethrex_` namespace. A test stub needs one cast to it (see `test/viem.test.ts`).
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

  return parseSimulateResult(result)
}

/**
 * `eth_sendRawTransaction` for a frame transaction.
 *
 * `raw` is the full wire form, `0x06 || rlp(body)`, as `encodeFrameTx` produces
 * it — the same bytes `simulateFrameTransaction` takes. This function does no
 * validation and no encoding: `rpc` sits below `envelope` in the module order
 * and must stay there. The strict path is
 * `assertValidFrameTx(tx)` → `encodeFrameTx(tx)` → here, and
 * `frameActions(client).sendFrameTransaction` in `src/viem.ts` walks it for you.
 *
 * The hash the node reports is checked against `keccak256(raw)`. The transaction
 * hash is defined as exactly that, so a mismatch means the node did not accept
 * the bytes we think we sent — the mirror of the pin `getFrameTransaction`
 * applies when reading.
 */
export async function sendRawFrameTransaction(client: FrameRpcClient, raw: Hex): Promise<Hex> {
  if (!/^0x06[0-9a-fA-F]*$/.test(raw))
    throw new FrameDecodeError('not a frame transaction: raw bytes must start with 0x06')

  const answer = (await client.request({
    method: 'eth_sendRawTransaction',
    params: [raw],
  })) as unknown

  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer))
    throw new FrameDecodeError(
      `eth_sendRawTransaction: answer must be a 32-byte hash, got ${JSON.stringify(answer)}`,
    )

  const expected = keccak256(raw)
  const reported = answer.toLowerCase() as Hex
  if (reported !== expected.toLowerCase())
    throw new FrameDecodeError(
      `eth_sendRawTransaction: node returned ${reported} for bytes hashing to ${expected}`,
    )
  return reported
}

/** A field is missing (`null`) or it is checked. Nothing here is cast. */
function asUnion<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T
  throw new FrameDecodeError(
    `simulate result: ${what} must be null or one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`,
  )
}

/**
 * A JSON-RPC quantity: `0x` and at least one hex digit.
 *
 * The prefix is required rather than handed to `BigInt`, which reads a
 * prefixless string as DECIMAL and both the empty string and whitespace as
 * zero. A node reporting `maxCost` in another format would otherwise produce a
 * quietly wrong number instead of an error, which is the failure this whole
 * function exists to prevent.
 */
function asHexScalar(value: unknown, what: string): bigint {
  if (typeof value !== 'string')
    throw new FrameDecodeError(
      `simulate result: ${what} must be a hex string, got ${JSON.stringify(value)}`,
    )
  if (!/^0x[0-9a-fA-F]+$/.test(value))
    throw new FrameDecodeError(
      `simulate result: ${what} is not a hex quantity: ${JSON.stringify(value)}`,
    )
  return BigInt(value)
}

function asOptionalHexScalar(value: unknown, what: string): bigint | null {
  return value === undefined || value === null ? null : asHexScalar(value, what)
}

function asOptionalString(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string')
    throw new FrameDecodeError(
      `simulate result: ${what} must be a string, got ${JSON.stringify(value)}`,
    )
  return value
}

function asOptionalAddress(value: unknown, what: string): Address | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string')
    throw new FrameDecodeError(
      `simulate result: ${what} must be an address, got ${JSON.stringify(value)}`,
    )
  try {
    return getAddress(value)
  } catch {
    throw new FrameDecodeError(`simulate result: ${what} is not an address: ${value}`)
  }
}

function asFrameResults(value: unknown): { gasUsed: bigint; succeeded: boolean }[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value))
    throw new FrameDecodeError(
      `simulate result: frames must be null or a list, got ${JSON.stringify(value)}`,
    )
  return value.map((entry, i) => {
    const frame = entry as Record<string, unknown> | null
    if (typeof frame?.succeeded !== 'boolean')
      throw new FrameDecodeError(
        `simulate result: frames[${i}].succeeded must be a boolean, got ${JSON.stringify(frame?.succeeded)}`,
      )
    return {
      gasUsed: asHexScalar(frame.gasUsed, `frames[${i}].gasUsed`),
      succeeded: frame.succeeded,
    }
  })
}

/**
 * Check the node's simulate response instead of casting it.
 *
 * `valid` is the field a caller keys the decision to relay off, and
 * `prefixShape` and `executionStatus` are closed unions the caller is expected
 * to switch on. A cast would let a value outside those sets through wearing the
 * union's type: a node that grows a fifth prefix shape, which this chain is
 * likely enough to do, would silently fall through every branch. The rest of
 * this module already refuses an out-of-range `mode`, `scheme` or receipt
 * `status`; this is the same rule applied to the same source.
 *
 * Every field goes through a checked helper so that a response this library
 * cannot read fails as a `FrameDecodeError` naming the field, rather than as a
 * `TypeError` out of `BigInt` or an address error out of viem.
 */
export function parseSimulateResult(
  result: Record<string, unknown>,
): SimulateFrameTransactionResult {
  if (typeof result.valid !== 'boolean')
    throw new FrameDecodeError(
      `simulate result: valid must be a boolean, got ${JSON.stringify(result.valid)}`,
    )

  return {
    valid: result.valid,
    prefixShape: asUnion(result.prefixShape, PREFIX_SHAPES, 'prefixShape'),
    payer: asOptionalAddress(result.payer, 'payer'),
    // Reported on every path, structural rejection included, because it is a
    // pure function of the fields (DESIGN.md §5, "The node's JSON surface").
    maxCost: asHexScalar(result.maxCost, 'maxCost'),
    violation: asOptionalString(result.violation, 'violation'),
    gasUsed: asOptionalHexScalar(result.gasUsed, 'gasUsed'),
    frames: asFrameResults(result.frames),
    executionStatus: asUnion(result.executionStatus, EXECUTION_STATUSES, 'executionStatus'),
    executionError: asOptionalString(result.executionError, 'executionError'),
  }
}
