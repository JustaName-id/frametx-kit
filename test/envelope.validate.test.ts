import { describe, expect, test } from 'vitest'
import { EXPIRY_VERIFIER, validateFrameTx } from '../src/envelope.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const VERIFY_FRAME = GOLDEN_TX.frames[0]! // mode 1, flags 3, no target
const SENDER_FRAME = GOLDEN_TX.frames[1]! // mode 2, flags 0, target 0x…1234

describe('validateFrameTx', () => {
  test('accepts the golden transaction', () => {
    expect(() => validateFrameTx(GOLDEN_TX)).not.toThrow()
  })

  test('rejects the zero address as sender', () => {
    expect(() =>
      validateFrameTx({ ...GOLDEN_TX, sender: `0x${'00'.repeat(20)}` }),
    ).toThrow(/zero address/)
  })

  test('rejects value on a non-SENDER frame', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, value: 1n }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/only SENDER frames/)
  })

  test('rejects reserved flag bits', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, flags: 0x08 }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/reserved/)
  })

  test('rejects an empty nonceKeys list', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [] })).toThrow(/between 1 and 16/)
  })

  test('rejects non-increasing nonce keys', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [2n, 2n] })).toThrow(
      /strictly increasing/,
    )
  })

  test('rejects a leading zero key when there is more than one', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [0n, 1n] })).toThrow(
      /first nonce key/,
    )
  })

  test('accepts a lone zero key', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [0n] })).not.toThrow()
  })

  test('rejects nonceSeq at 2**64 - 1', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceSeq: 2n ** 64n - 1n })).toThrow(/nonceSeq/)
  })

  test('rejects more than 64 frames', () => {
    const frames = Array.from({ length: 65 }, () => SENDER_FRAME)
    expect(() => validateFrameTx({ ...GOLDEN_TX, frames })).toThrow(/at most 64/)
  })

  test('rejects an empty frames list', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, frames: [] })).toThrow(/at least one frame/)
  })

  test('rejects a non-null signer on an ARBITRARY signature', () => {
    const tx = { ...GOLDEN_TX, signatures: [{ ...GOLDEN_TX.signatures[0]!, scheme: 0 as const }] }
    expect(() => validateFrameTx(tx)).toThrow(/ARBITRARY/)
  })

  test('rejects a msg that is neither empty nor 32 bytes', () => {
    const tx = { ...GOLDEN_TX, signatures: [{ ...GOLDEN_TX.signatures[0]!, msg: '0x1122' as const }] }
    expect(() => validateFrameTx(tx)).toThrow(/32 bytes/)
  })

  test('rejects an all-zero explicit msg', () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [{ ...GOLDEN_TX.signatures[0]!, msg: `0x${'00'.repeat(32)}` as const }],
    }
    expect(() => validateFrameTx(tx)).toThrow(/zero digest/)
  })

  test('rejects a blob fee when there are no blobs', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, maxFeePerBlobGas: 1n })).toThrow(/no blobs/)
  })

  test('rejects a blob hash without the KZG version byte', () => {
    const tx = { ...GOLDEN_TX, blobVersionedHashes: [`0x02${'ab'.repeat(31)}` as const] }
    expect(() => validateFrameTx(tx)).toThrow(/version byte/)
  })

  test('rejects APPROVE_EXECUTION on a frame targeting a third party', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [
        { ...VERIFY_FRAME, target: '0x0000000000000000000000000000000000009999' as const },
        SENDER_FRAME,
      ],
    }
    expect(() => validateFrameTx(tx)).toThrow(/APPROVE_EXECUTION/)
  })

  test('rejects the atomic-batch flag on a VERIFY frame', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, flags: 0x7 }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/atomic batch/)
  })

  test('rejects the atomic-batch flag on the last frame', () => {
    const tx = { ...GOLDEN_TX, frames: [VERIFY_FRAME, { ...SENDER_FRAME, flags: 0x4 }] }
    expect(() => validateFrameTx(tx)).toThrow(/last frame/)
  })

  test('rejects a scope approval inside an atomic batch', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [VERIFY_FRAME, { ...SENDER_FRAME, flags: 0x4 }, { ...SENDER_FRAME, flags: 0x1 }],
    }
    expect(() => validateFrameTx(tx)).toThrow(/approve a scope/)
  })

  test('accepts a well-formed atomic batch', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [VERIFY_FRAME, { ...SENDER_FRAME, flags: 0x4 }, SENDER_FRAME],
    }
    expect(() => validateFrameTx(tx)).not.toThrow()
  })

  test('rejects an expiry-verifier frame with the wrong data length', () => {
    const expiry = { ...VERIFY_FRAME, flags: 0, target: EXPIRY_VERIFIER, data: '0x1122' as const }
    const tx = { ...GOLDEN_TX, frames: [expiry, VERIFY_FRAME, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/8 bytes/)
  })
})

describe('validateFrameTx: single-byte and 32-byte wire fields', () => {
  // ethrex decodes `flags` as u64 then `u8::try_from`, rejecting with
  // "Frame flags too large". Bit 8 clears the reserved-bits mask (0xf8) but
  // the encoder would emit a two-byte scalar for a field the chain reads as one.
  test('rejects flags that do not fit in one byte', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, flags: 0x100 }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/flags.*one byte/)
  })

  // `source_id` and `root` are H256 in ethrex, decoded through the fixed
  // `[u8; 32]` impl, which fails with InvalidLength for any other size.
  test('rejects a recent-root sourceId that is not 32 bytes', () => {
    const tx = {
      ...GOLDEN_TX,
      recentRootReferences: [
        { sourceId: `0x${'11'.repeat(31)}` as const, slot: 1n, root: `0x${'22'.repeat(32)}` as const },
      ],
    }
    expect(() => validateFrameTx(tx)).toThrow(/sourceId must be 32 bytes/)
  })

  test('rejects a recent-root root that is not 32 bytes', () => {
    const tx = {
      ...GOLDEN_TX,
      recentRootReferences: [
        { sourceId: `0x${'11'.repeat(32)}` as const, slot: 1n, root: `0x${'22'.repeat(33)}` as const },
      ],
    }
    expect(() => validateFrameTx(tx)).toThrow(/root must be 32 bytes/)
  })

  test('accepts a well-formed recent-root reference', () => {
    const tx = {
      ...GOLDEN_TX,
      recentRootReferences: [
        { sourceId: `0x${'11'.repeat(32)}` as const, slot: 1n, root: `0x${'22'.repeat(32)}` as const },
      ],
    }
    expect(() => validateFrameTx(tx)).not.toThrow()
  })
})
