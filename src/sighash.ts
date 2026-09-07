import { type Hex, keccak256 } from 'viem'
import { encodeFrameTx } from './envelope.js'
import type { FrameTransaction } from './types.js'

/**
 * EIP-8141 `sig_hash`: keccak256 over the full wire encoding, with the raw
 * `signature` bytes of every empty-`msg` signature replaced by empty bytes.
 *
 * A signature over the sig-hash cannot commit to its own bytes, hence the
 * elision. A signature carrying an explicit 32-byte `msg` signs that digest
 * instead, so its bytes stay committed.
 */
export function frameTxSigHash(tx: FrameTransaction): Hex {
  const elided: FrameTransaction = {
    ...tx,
    signatures: tx.signatures.map((sig) =>
      sig.msg === '0x' ? { ...sig, signature: '0x' } : sig,
    ),
  }
  return keccak256(encodeFrameTx(elided))
}
