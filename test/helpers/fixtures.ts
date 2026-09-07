import { readFileSync, readdirSync } from 'node:fs'
import type { Hex } from 'viem'
import type { RpcFrameReceiptJson, RpcFrameTransaction } from '../../src/rpc.js'

export type ChainFixture = {
  name: string
  meta: {
    clientVersion: string
    genesisHash: Hex
    capturedAt: string
    block: string
    rawSource: string
  }
  /** As served by a hydrated `eth_getBlockByNumber`; `hash` is always present. */
  tx: RpcFrameTransaction & { hash: Hex }
  /** The full receipt; only the frame fields and `gasUsed` are read. */
  receipt: RpcFrameReceiptJson & { gasUsed: Hex }
  /** `ethrex_simulateFrameTransaction` over our re-encoding, at capture time. */
  simulate: {
    valid: boolean
    maxCost: Hex
    prefixShape: string | null
    violation: string | null
  }
}

const DIR = new URL('../fixtures/chain/', import.meta.url)

export function loadChainFixtures(): ChainFixture[] {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
  return files.map((name) => ({
    name,
    ...(JSON.parse(readFileSync(new URL(name, DIR), 'utf8')) as Omit<ChainFixture, 'name'>),
  }))
}
