/**
 * Capture live type-0x06 transactions as test fixtures.
 *
 * The public endpoint serves no raw transaction bytes — ethrex has no
 * `eth_getRawTransactionByHash`, and `debug_getRawTransaction` is refused by
 * rpc1.privacy.ethrex.xyz — so a fixture holds what the node DOES serve: the
 * decoded transaction JSON (with its hash), the receipt, and the node's answer
 * to `ethrex_simulateFrameTransaction` over OUR re-encoding of that JSON. The
 * raw bytes are re-derived by the tests and pinned by the transaction hash,
 * which is keccak256 of exactly those bytes.
 *
 * Records the client version and genesis hash each capture was taken against, so
 * a stale fixture set after a re-genesis is detectable rather than silently
 * wrong. This chain is already on its third genesis; both known divergences are
 * fixed on the branch and land on the chain at the next relaunch.
 *
 * Usage: bunx tsx scripts/capture-fixtures.ts [from-block] [to-block]
 *   Defaults to the last 500 blocks. Frame transactions are sparse; on the third
 *   genesis, blocks 2782, 2787 and 2792 are known to carry one each.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { type Hex, keccak256 } from 'viem'
import { encodeFrameTx } from '../src/envelope.js'
import { type RpcFrameTransaction, parseRpcFrameTransaction } from '../src/rpc.js'

const RPC_URL = 'https://rpc1.privacy.ethrex.xyz'
const EXPECTED_CHAIN_ID = 8141n
const OUT_DIR = new URL('../test/fixtures/chain/', import.meta.url)

let nextId = 0
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  })
  const body = (await response.json()) as {
    result?: T
    error?: { code: number; message: string }
  }
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`)
  return body.result as T
}

type HydratedTx = RpcFrameTransaction & { hash: Hex; type: string }

async function main() {
  const chainId = BigInt(await rpc<Hex>('eth_chainId', []))
  if (chainId !== EXPECTED_CHAIN_ID)
    throw new Error(`expected chain ${EXPECTED_CHAIN_ID}, got ${chainId}`)

  const clientVersion = await rpc<string>('web3_clientVersion', [])
  const genesis = await rpc<{ hash: Hex }>('eth_getBlockByNumber', ['0x0', false])
  const head = BigInt(await rpc<Hex>('eth_blockNumber', []))

  const to = process.argv[3] ? BigInt(process.argv[3]) : head
  const from = process.argv[2] ? BigInt(process.argv[2]) : to > 500n ? to - 500n : 0n

  mkdirSync(OUT_DIR, { recursive: true })
  const captured: string[] = []

  for (let n = from; n <= to; n++) {
    const block = await rpc<{ transactions: HydratedTx[] }>('eth_getBlockByNumber', [
      `0x${n.toString(16)}`,
      true,
    ])
    for (const tx of block.transactions) {
      if (tx.type !== '0x6') continue // `{:#x}` of 6 is one hex digit, not two

      const receipt = await rpc<unknown>('eth_getTransactionReceipt', [tx.hash])

      // Our re-encoding. Checked against the hash here only to WARN: a mismatch is
      // a finding for Oracle 2 in test/oracles.test.ts, which fails loudly, so
      // the fixture is still written. `simulate` over wrong bytes is then noise.
      const raw = encodeFrameTx(parseRpcFrameTransaction(tx))
      if (keccak256(raw) !== tx.hash)
        console.warn(`block ${n} ${tx.hash}: re-encoding does not reproduce the hash`)

      // The node's verdict on our bytes. `maxCost` is a pure function of the
      // fields (hermetic oracle); `violation` records how far the node got —
      // anything past "does not authenticate the sender" means our sig_hash
      // over a real signature matched. Only `latest` is available: state is pruned.
      const simulate = await rpc<unknown>('ethrex_simulateFrameTransaction', [raw, 'latest'])

      writeFileSync(
        new URL(`${tx.hash}.json`, OUT_DIR),
        `${JSON.stringify(
          {
            meta: {
              clientVersion,
              genesisHash: genesis.hash,
              capturedAt: new Date().toISOString(),
              block: n.toString(),
              rawSource: 'reconstructed from JSON; pinned by hash in test/oracles.test.ts',
            },
            tx,
            receipt,
            simulate,
          },
          null,
          2,
        )}\n`,
      )
      captured.push(tx.hash)
      console.log(`block ${n}: ${tx.hash}`)
    }
  }

  console.log(`captured ${captured.length} frame transactions from blocks ${from}..${to}`)
  if (captured.length === 0)
    console.warn('no type-0x06 transactions found — widen the range, or try `2780 2800`')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
