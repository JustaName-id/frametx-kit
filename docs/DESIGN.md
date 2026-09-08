# frametx-kit — design

**Date:** 2026-09-06
**Status:** implemented; binding on the code in this repository. Reviewed against ethrex `hegota-testnet` @ `19c065fa8` and the live node on 2026-09-06; §5, §6 and §9 amended for the RPC surface actually served (no raw transaction bytes). §5, §7 and §8 amended 2026-09-07 to match the module graph, strict-decode surface and entry-point name as built. §7 amended 2026-09-08: the byte-offset promise is delivered by a hand-rolled `walkRlp`, not deferred.
**Target network:** hegota-testnet, chain ID `8141`, genesis `0x7ca0f735…cd0f2332`
**Reference client:** [`lambdaclass/ethrex`, branch `hegota-testnet`](https://github.com/lambdaclass/ethrex/tree/hegota-testnet). Every `.rs`, `.py` and `docs/*.md` path cited below is a path in that repository, not in this one.

A TypeScript library for reading, building, hashing, pricing and simulating EIP-8141 frame
transactions as they exist on hegota-testnet — the composed envelope that also carries
EIP-8250 keyed nonces and EIP-8272 recent-root references.

## 1. Why this exists

**No JavaScript can touch this chain.** The only frame-transaction encoders are ethrex's Rust
implementation and ethrex's own `scripts/hegota-testnet/frametx.py` (126 lines). viem PR 4486 is a draft,
last touched 2026-05-06, with zero human review; it implements a pre-composition EIP-8141
envelope with a flat `nonce`, flat fees, no `limits`, no recent-root references, and — across
its whole 3372-line diff — no `signatures` field and no `sig_hash`. It cannot authenticate a
frame transaction, and its bytes are not the bytes this chain accepts.

**A second implementation with hardcoded published figures catches a class of drift that
derived-constant tests cannot.** From `crates/common/types/transaction.rs:2215-2220`:

> EIP-8141 publishes these in its Constants table; assert the constants reproduce them exactly,
> so a repricing or a re-spelling upstream is a compile error here rather than a silent
> consensus change. […] the reason the intrinsic drop from 15000 to 12000 was invisible to 1372
> tests: the suite derives its expected intrinsic from this constant, so it can check the
> formula's composition but never the published figure.

The same blindness applies to the wire format. From `test/tests/common/frame_tx_wire_tests.rs:3-8`:

> Nothing in this suite pinned the frame-transaction encoding before: every frame-tx test either
> round-trips (so a changed layout stays symmetric and invisible) or asserts behaviour. Changing
> the envelope therefore passed 1367 tests without a murmur, while every joiner's transaction
> builder would have broken.

This library is that joiner's transaction builder, written to the published numbers rather than
to ethrex's constants.

**Primary goal is understanding, verifiably.** Every milestone terminates in a check that fails
loudly when comprehension is wrong: an exact byte string, a field-by-field diff against the
node, a recovered address, a gas figure from a real receipt.

### Non-goal

This is not a fork of, or a PR against, viem core. It is a standalone package with a viem
*extension* surface (`client.extend()`), which is how tooling for unsettled EIPs normally
ships. If the EIPs stabilize and viem wants frames in core, this becomes the reference an
eventual PR borrows from.

## 2. Scope

### In scope (pass 1)

Decoding, encoding, `sig_hash`, signing, the gas model, and `ethrex_simulateFrameTransaction`.

`ethrex_simulateFrameTransaction` takes a **raw hex string** as its first parameter
(`crates/networking/rpc/ethrex.rs:120`) and replays "EIP-8141 static constraints and signature
authentication" (`ethrex.rs:44`). Simulation therefore requires a working encoder and real
signatures. "Read-only plus simulate" is everything except broadcast.

Signing uses a throwaway key that holds no funds. Nothing in pass 1 can alter chain state.

### Deferred (pass 2)

`eth_sendRawTransaction`: submitting a live frame transaction, funded from
`faucet.privacy.ethrex.xyz`, and reading back per-frame receipts.

### Out of scope

Key management beyond a throwaway signer. Blob data beyond carrying `blobVersionedHashes`
through the envelope. UTXO frames — mode 5, EIP-8312, inert on this chain because
`utxoFramesTime` is unset. Anything FOCIL or inclusion-list, which is consensus-side and not
transaction-building. Any UI; the inspector is a separate later project that consumes this one.

## 3. The envelope

What the chain accepts (`scripts/hegota-testnet/frametx.py:11-17`):

```
raw = 0x06 || rlp([chain_id, nonce_keys, nonce_seq, sender, frames, signatures,
                   fees, blob_hashes, recent_root_references])

fees      = rlp([max_priority_fee, max_fee, max_blob_fee])
frame     = rlp([mode, flags, target_or_empty, limits, value, data])
limits    = rlp([execution, state])
signature = rlp([scheme, signer, msg, signature_bytes])
```

The composition of the three EIPs is this chain's own choice — none of the three specifies it.
EIP-8250 replaces the scalar `nonce` with `nonce_keys, nonce_seq` in place, EIP-8272 appends
`recent_root_references` last, and EIP-8141's `fees` list sits where its three flat fee fields
used to be.

> **`docs/eip-8141.md:78` in the ethrex branch still documents the pre-composition layout** —
> flat `nonce`, flat fee fields, and a frame as `[mode, flags, target, gas_limit, value, data]`
> with no `limits` nesting. Anyone building from that section produces bytes the node rejects.
> Reporting this is a candidate contribution (§10).

### sig_hash

```
sig_hash = keccak256(0x06 || rlp(envelope with empty-msg signatures' bytes elided))
```

Each signature whose `msg` is empty has its `signature` field replaced with empty bytes,
because a signature over `compute_sig_hash` cannot commit to its own bytes. Signatures with an
explicit 32-byte `msg` keep their bytes — they sign that digest, not this hash. All frame data
is committed verbatim.

The consequence for the API: **the encoder is a dependency of the decoder's verification
path**, because `sig_hash` is defined over a re-encoding. Read-only work still exercises the
full round trip.

### Signature schemes and canonical rules

`scheme`: 0 ARBITRARY, 1 SECP256K1, 2 P256.

- ARBITRARY — `signer` MUST be empty; `signature` is arbitrary bytes, EVM-readable via
  `SIGPARAM` param `0x04`. No ECDSA rules apply.
- SECP256K1 — `signature = v||r||s`, 65 bytes; `v` is a **bare recovery id (`v <= 1`, not the
  EVM's 27/28)**; `0 < r < SECP256K1N`; `s` low (`0 < s <= SECP256K1N/2`).
- P256 — `signature = r||s||qx||qy`, 128 bytes; `0 < r < SECP256R1N`; `0 < s <= SECP256R1N/2`.
  `P256VERIFY` itself accepts high-`s`, so the signer must normalize `s` to `n - s` before use.

These are **consensus rules**, checked in `validate_frame_signatures` before any frame executes.
A high-`s` or 27/28-encoded signature makes the whole transaction invalid, not merely
unrelayable — which makes them a correctness requirement of this library, not a lint.

An empty `signer` resolves to `tx.sender` for SECP256K1 and P256, including for EVM
introspection.

### Signing

`signFrameTx(tx, signer)` takes either a raw private key or a `FrameAccount` —
`{ address, sign }`, satisfied by viem's `privateKeyToAccount` and `mnemonicToAccount`, by a
`toAccount` source, and by any wrapper around a hardware wallet, an HSM or a remote signer.
It signs exactly the entries that are SECP256K1 with an empty `msg`, over `sig_hash`, and
refuses when an entry's resolved signer is not the account's address — otherwise the result
would recover to the wrong address and be rejected at consensus with no local error.

**Raw-digest signing is required.** `signMessage` prefixes its argument per EIP-191, so it
cannot produce a signature over `sig_hash`, and a `JsonRpcAccount` cannot sign a raw digest
at all. Both are refused with an error rather than silently producing an unrecoverable
signature. `sign` is typed optional because it is optional on viem's own `LocalAccount`;
the check is at runtime.

**A returned `v` is normalized, not assumed.** viem returns 27/28; HSMs and hand-rolled
wrappers commonly return a bare 0/1. Both are accepted. An EIP-155 `v` is refused: it
encodes a chain id this layout has no room for, and guessing at its parity would forge a
recovery id. Subtracting 27 unconditionally — the obvious implementation — writes `0x-1a…`
into the signature, malformed hex that surfaces only as a byte-alignment error naming the
wrong problem.

This does not widen §2's out-of-scope line on key management. The account form holds no key
material; it delegates key management to the caller instead of doing any.

### Structural limits

| Constant | Value | Source |
|---|---|---|
| `FRAME_TX_MAX_FRAMES` | 64 | `transaction.rs:2209` |
| `FRAME_TX_MAX_NONCE_KEYS` | 16 | `transaction.rs:2211` |
| `FRAME_TX_MAX_RECENT_ROOT_REFERENCES` | 16 | `transaction.rs:2213` |
| `FRAME_TX_EXPIRY_DATA_LENGTH` | 8 | `transaction.rs:2273` |

`nonce_keys` rules (`transaction.rs:2679-2694`): between 1 and 16 entries; strictly increasing;
if more than one entry, the first may not be zero. Frame `value` must be zero unless the frame
is SENDER. Frame `flags` bits 0-1 are the APPROVE scope restriction, bit 2 the atomic-batch
flag, bits 3-7 reserved and must be zero.

EIP-8272 window: `RECENT_ROOT_LENGTH = 8192`, and a declared reference is valid iff
`1 <= current_slot - slot <= 8191`. Domain separators are `keccak256("RECENT_ROOT_ENTRY")` and
`keccak256("RECENT_ROOT_STORAGE")`.

## 4. The gas model

Transcribed from `crates/common/types/transaction.rs`, which is the branch's current
(post-`77e502ef4`) behaviour. Every constant is written as its published figure.

```
value_transfer_cost = Σ 6000  over frames where value != 0
                                 AND target is present
                                 AND target != sender

signature_verification_cost = Σ per signature: ARBITRARY 100, SECP256K1 2800, P256 6700

mandatory_gas = 12000
              + 475 * len(frames)
              + signature_verification_cost
              + value_transfer_cost

billed_bytes = concat( frame.data for each frame,
                       sig.signer, sig.msg, sig.signature for each signature,
                       nonce_calldata,
                       recent_root_calldata )

nonce_calldata       = rlp(nonce_keys) || rlp(nonce_seq)
recent_root_calldata = rlp(recent_root_references), or empty when no reference is declared

data_cost = Σ over billed_bytes: 4 if byte == 0 else 16

recent_root_reference_intrinsic_gas = 0                              when no references
                                    = 2400 + 2002 * len(references)  otherwise

frame_tx_intrinsic_gas = mandatory_gas + data_cost + recent_root_reference_intrinsic_gas

state_gas_limit    = Σ frame.limits.state
standard_gas_limit = frame_tx_intrinsic_gas
                   + Σ frame.limits.execution
                   + state_gas_limit

calldata_tokens      = len(billed_bytes) * 4
calldata_floor_gas   = calldata_tokens * 16          # 64 gas per byte
calldata_floor_total = mandatory_gas
                     + recent_root_reference_intrinsic_gas
                     + calldata_floor_gas

max_gas  = max(standard_gas_limit, calldata_floor_total + state_gas_limit)
max_cost = max_gas * max_fee_per_gas
         + len(blob_versioned_hashes) * 131072 * blob_base_fee
```

Four traps worth naming, because each is a place a reimplementation goes quietly wrong:

1. **The RLP framing and the scalar fields are not billed** — only the byte fields listed in
   `billed_bytes`. But `nonce_calldata` and `recent_root_calldata` *are* RLP encodings, and
   their framing bytes are billed, because the EIP prices the bytes those EIPs add to the
   payload.
2. **`recent_root_calldata` is empty, not `rlp([])`, when no reference is declared**
   (`transaction.rs:2538-2540`), so a reference-free transaction's gas is exactly the EIP-8141
   figure. Encoding `rlp([])` here would add billed bytes to every transaction on the chain.
3. **State gas sits outside the floor and is added on top of it** — `max_gas` takes
   `calldata_floor_total + state_gas_limit`, not `calldata_floor_total`. Both bound an
   execution-dimension resource, so the floor branch cannot absorb the state sum.
4. **`frame_tx_intrinsic_gas` must be computed directly, never as
   `total_gas_limit − frame budgets`**, because `total_gas_limit` may be the floor branch.

The EIP-7825 per-transaction cap applies to a *different* quantity —
`frame_tx_intrinsic_gas + Σ frame.limits.execution`, state excluded — and is checked separately.

The published intrinsic is **12000**, down from an earlier 15000 (`transaction.rs:2189-2195`).
`docs/eip-8141.md:362` in the ethrex branch still says 15000, and its formulas omit both
`state_gas_limit` and `recent_root_reference_intrinsic_gas`. Second candidate contribution (§10).

### Rule sets

The gas module takes a rule-set parameter. This is load-bearing, not generality for its own
sake: the deployed nodes run ethrex `31b532266`, which carries two divergences from the pinned
EIP text, so a single hardcoded model cannot be simultaneously correct and green against live
data.

| Rule set | Meaning |
|---|---|
| `'chain'` | What `31b532266` does — the two live divergences included |
| `'pins'` | The pinned EIP text: EIP-8141 `7d1c8bfb94`, EIP-8250 `e5cf246ff1`, EIP-8272 `0231fb05f5` |
| `'head'` | Current drafts, for anticipating the next re-genesis |

The two divergences that separate `'chain'` from `'pins'`:

- **`value_cost`** — the chain charges `TX_VALUE_COST` for every frame with `value > 0`; the
  pins charge it only when the frame has a target that is not `tx.sender`. A targetless or
  self-targeted value frame is overcharged 6,000 on the live chain. The branch code at
  `transaction.rs:2524-2531` already implements the pinned rule, so branch behaviour is
  `'pins'` and deployed behaviour is `'chain'`.
- **`SIGPARAM(0x03)`** — the chain returns `len(signature)` for every scheme; the pins permit it
  for ARBITRARY entries only and require an exceptional halt otherwise. This one is not a gas
  divergence and affects validation-prefix replay rather than the gas model, so it is recorded
  but not modelled in pass 1.

What `'head'` changes, per the branch spec's "Changed upstream since the pins":

- **EIP-8250** moves the first use of a keyed nonce from 20,000 execution gas, deducted from the
  frame's remaining gas, to **97,920 state gas** charged during the payment `APPROVE`. A frame
  consuming two fresh nullifier keys needs 195,840 of `limits.state` under `'head'` and none
  here.
- **EIP-8272** drops the envelope field, `TXPARAM 0x11` and `RECENTROOTREFLOAD` entirely,
  carrying references instead as a leading VERIFY frame targeting
  `0x0000000000000000000000000000000000008272`, each `(source_id, slot, root)` packed into 72
  bytes of frame data. This changes the *envelope*, not only the gas, so `'head'` cannot share
  the `'chain'` encoder. `divergence.toHeadShape` applies the change as a transformation of the
  transaction: the field is emptied and its contents prepended as one VERIFY frame with zero
  limits, which the existing pricer then prices. `compareRuleSets` routes whichever side names `'head'`
  through it. `gas` fabricates nothing and `frameTxGas(tx, 'head')` still refuses a
  reference-carrying transaction, so the floor that zero limits produce cannot be mistaken for a
  budget. No second serializer: the transform yields a `FrameTransaction`, never bytes.

## 5. Modules

Ten source files in dependency order. Nothing depends on anything above it.

| Module | Responsibility | Depends on |
|---|---|---|
| `types` | The `FrameTransaction` shape and the `RuleSet` union. | viem types only |
| `errors` | Typed error classes with stable `name`s. | — |
| `rlp` | `rlpUint`, `parseRlpUint`, `byteLength`: minimal-scalar rules viem does not enforce; `walkRlp`, an offset-tracking RLP reader that rejects the non-canonical encodings `fromRlp` accepts. | `errors` |
| `envelope` | `encodeFrameTx`, `decodeFrameTx`, `validateFrameTx`. Pure, no IO. | `rlp`, `errors`, `types`, viem `toRlp` |
| `sighash` | The elision rule plus keccak256. | `envelope` |
| `signatures` | Canonical rules, signer recovery, empty-signer resolution, signing (private key or external account), `assertValidFrameTx`. | `sighash`, `envelope` |
| `gas` | The whole of §4, parameterized by rule set. Pure, no IO. | `rlp`, `errors`, `types` only |
| `divergence` | `compareRuleSets` and the head EIP-8250 state-gas figure. | `gas` |
| `rpc` | Typed `ethrex_simulateFrameTransaction`; frame-aware transaction and receipt formatters. | `errors`, `types` only |
| `viem` | `client.extend(frameActions)`. Thin — no logic of its own. | `envelope`, `rpc`, `gas` |
| `fixtures` | The golden vector plus captured real transactions, as JSON. | — |

`gas` deliberately does not depend on `envelope` or `rpc`, and `rpc` does not depend on
`envelope`. The gas model is the thing being learned, so it stays a pure function testable
offline against a table of cases, and independently wrong or independently right of the
encoder. The small duplication this causes (a `sameAddress` helper, the framing of two
calldata blobs) is deliberate; `CONTRIBUTING.md` lists it among the rules that are not style
preferences.

Crypto is borrowed, not written: viem supplies RLP, keccak256 and secp256k1. The envelope is
hand-rolled because it is the object of study; ECDSA is not.

### The node's JSON surface

`eth_getTransactionByHash` returns a decoded frame transaction with fields `type`, `chainId`,
`nonceKeys`, `nonceSeq`, `sender`, `frames`, `signatures`, `maxPriorityFeePerGas`,
`maxFeePerGas`, `maxFeePerBlobGas`, `blobVersionedHashes`, `recentRootReferences`
(`transaction.rs:4109-4155`).

`eth_getTransactionReceipt` adds `payer` and `frameReceipts[]`, each entry carrying `status`,
`gasUsed`, `stateGasUsed` and `logs` (`crates/networking/rpc/types/receipt.rs:33-47`).
**`status` is three-valued: 0 failure, 1 success, 2 skipped** (atomic-batch failure). Skipped
frames never executed and their gas was refunded, so collapsing 2 into "reverted" is wrong —
this is precisely the defect in viem PR 4486 (§10).

`ethrex_simulateFrameTransaction` returns `valid`, `prefixShape`, `payer`, `maxCost`,
`violation`, `gasUsed`, `frames[]` (`gasUsed`, `succeeded`), `executionStatus` and
`executionError` (`crates/networking/rpc/ethrex.rs:41-95`). `prefixShape` is one of
`SelfVerify`, `DeploySelfVerify`, `OnlyVerifyPay`, `DeployOnlyVerifyPay`. Its `valid` is
necessary but not sufficient for admission: the gates shared with every other transaction type,
and the per-sender pending-frame rule, are not replayed. `maxCost` is reported on every path,
including structural rejection, because it is a pure function of the fields. Only `latest` is
usable as the block parameter: the public node has pruned historical state.

**No raw transaction bytes are served.** ethrex has no `eth_getRawTransactionByHash`
(`Method not found`), and `debug_getRawTransaction` — present in the binary, and returning the
canonical `0x06…` bytes — is refused by `rpc1.privacy.ethrex.xyz` (`not available on this
endpoint`) despite `docs/hegota-testnet-spec.md:74` listing `debug` as exposed. The raw bytes of
a live transaction can only be *reconstructed* from its JSON. This is not a weakness once
noticed: the transaction hash is `keccak256(0x06 || rlp(body))`, so a reconstruction that
reproduces the hash is the bytes, and a reconstruction that does not is a finding.

## 6. Verification — three oracles

All three get wired. Each catches what the others miss.

**Oracle 1 — the golden vector.** Offline and exact. From
`test/tests/common/frame_tx_wire_tests.rs:67-69`:

```
GOLDEN_RLP      = f8b301c1800794000000000000000000000000000000000000abcdeccc010380c48252088080821122de0280940000000000000000000000000000000000001234c4829c40808080f85cf85a0194000000000000000000000000000000000000abcd80b8410101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101cc843b9aca008506fc23ac0080c0c0
GOLDEN_SIG_HASH = 0xd4df51143828c0338882dbd10c3308f3569972fe1928a7b5040ee18057920510
```

The transaction it encodes (`frame_tx_wire_tests.rs:22-60`): `chain_id` 1, `nonce_keys` `[0]`,
`nonce_seq` 7, `sender` `0x…abcd`, two frames — a targetless VERIFY with `flags` 3, execution
limit `0x5208`, no state limit, data `0x1122`; then a SENDER frame targeting `0x…1234`,
execution limit `0x9c40`, empty data — one SECP256K1 signature with signer `0x…abcd`, empty
`msg`, 65 bytes of `0x01`, `max_priority_fee_per_gas` `0x3b9aca00`, `max_fee_per_gas`
`0x6fc23ac00`, no blobs, no recent-root references.

Catches absolute byte layout. Hermetic; runs in CI.

**Oracle 2 — the transaction hash over a re-encoding of the node's JSON.** Parse the node's
decoded JSON for a live transaction, re-encode it, and assert
`keccak256(encodeFrameTx(parseRpcFrameTransaction(json))) === json.hash`. The hash is keccak256
of the canonical bytes, so this pins the absolute layout of a real transaction as tightly as a
raw-bytes diff would — and more tightly than a field-by-field diff of two decoders, which cannot
see a mis-nesting both make. Then, decoder side, `decodeFrameTx(bytes)` must equal the parsed
JSON. Needs no golden vector and no raw-bytes RPC. Verified on 2026-09-06 against three live
transactions, one carrying two keyed nonces and a recent-root reference.

Round-trip (`decode(encode(x)) === x`) is *also* implemented but never trusted alone: it is
symmetric-blind, which is exactly how an envelope change passed 1367 ethrex tests.

**Oracle 3 — semantic cross-checks against the chain.** For every captured transaction:

- Recovered signer equals the *resolved* signer — `signer`, or `sender` when `signer` is empty
  — for SECP256K1 entries with an empty `msg`. On this chain the two usually differ: the
  shielded pool's spends have the pool contract as `sender` and an EOA as `signer`.
- Computed `max_cost` under `'chain'` matches `maxCost` from
  `ethrex_simulateFrameTransaction` over our re-encoding — the node's figure computed from
  our bytes, and a pure function of the fields, so it is hermetic once captured.
- The receipt reconciles exactly: `gasUsed = frame_tx_intrinsic_gas + Σ frameReceipts[].gasUsed
  + Σ frameReceipts[].stateGasUsed`. Observed with a zero delta on every live transaction
  checked.
- The node gets past signature authentication over our re-encoding: `violation` from
  `ethrex_simulateFrameTransaction` is never "frame signature list does not authenticate the
  sender". That is our `sig_hash` agreeing with the node's over a real signature.

Oracle 3 is where the rule sets pay off. A `'pins'` model that disagrees with a live receipt by
exactly 6,000 on a targetless value frame has independently reproduced divergence-ledger row
3.8 rather than read about it. A disagreement that is *not* 6,000 and *not* explainable is a
finding worth reporting.

## 7. Errors and strictness

Encoding and inspecting want opposite defaults.

**Encode is strict.** Reserved flag bits must be zero; signatures must be canonical; mode
restricted to 0, 1, 2; structural limits enforced; `value` non-zero only on SENDER frames.
Violations throw a typed error before any bytes are produced.

**Decode is lenient.** It must decode anything the chain accepted, including shapes that look
wrong, and surface them as findings rather than throwing — a surveyor that dies on one odd
transaction cannot survey. Strict decode is not a flag: it is `decodeFrameTx(raw)` followed by
`assertValidFrameTx(tx)`, so the strict rules live in one place instead of two. Malformed RLP
produces a typed error carrying **the byte offset at which parsing failed**: `decodeFrameTx`
walks the body with `walkRlp` (in `rlp.ts`), a small offset-tracking RLP reader, rather than
viem's `fromRlp`, which exposes no offset. The offset is into the full transaction, counting
the `0x06` type byte as byte 0, so it indexes straight into the hex the caller passed.
`walkRlp` also rejects **non-canonical RLP** — a long-form encoding of a single-byte scalar,
say — at the offending byte, because ethrex rejects those bytes at RLP decode while `fromRlp`
silently canonicalizes them; that is a well-formedness rule about the bytes, not a structural
rule about the transaction, so it does not make decode any less lenient about the shapes the
chain actually accepted. It also keeps the two guards `fromRlp` applied and a bare
`hexToBytes` does not: a non-byte-aligned string is rejected rather than nibble-padded, and
nesting is capped at 1024 so pathological input throws a typed error instead of exhausting
the stack. A re-encoding is still compared against the input as a cheap independent
backstop; that comparison carries no offset, since a mismatch could be anywhere.

Every error is a typed class with a stable `name`, following viem's error conventions so the
extension surface composes with viem's own error handling.

## 8. Testing and repo mechanics

TypeScript in strict mode; Vitest, which is viem's own runner; the package exports a root entry
point and a `./viem` entry point (`@jaw.id/frametx-kit/viem`) for the extension surface.

Two suites. The **default suite is hermetic**, running entirely off checked-in fixtures, so CI
never depends on a testnet staying up. The **`test:live` suite** is opt-in behind an env var
and hits `https://rpc1.privacy.ethrex.xyz`.

Fixtures are captured by a script so they can be refreshed. They will need refreshing: both
divergences are "fixed on the branch, on the chain at the next relaunch", and a re-genesis
wipes the chain — this one is already the third genesis, the previous chain having ended at
block 313,106. Fixtures record the `web3_clientVersion` and genesis hash they were captured
against, so a stale fixture set is detectable rather than silently wrong.

Development is test-first throughout: each milestone's oracle is written before the code that
satisfies it.

## 9. Milestones

Each terminates in a check that fails loudly when understanding is wrong.

1. **Decode.** Raw hex to structured object. Gate: decode `GOLDEN_RLP` to the documented
   transaction. (Oracle 2 over live transactions needs the encoder and the RPC parser, so it
   lands with milestones 2 and 5's RPC formatters, not here.)
2. **Encode and `sig_hash`.** Gate: reproduce `GOLDEN_RLP` and `GOLDEN_SIG_HASH` byte-for-byte
   from a hand-built transaction. Passing this means the envelope is understood.
3. **Signatures.** Canonical rules, recovery, P256 normalization. Gate: recovered signer equals
   `sender` for every captured SECP256K1 transaction.
4. **Gas model with rule sets.** Gate: `'chain'` agrees with live receipts and with simulated
   `maxCost`; `'pins'` disagrees only where the ledger says it should, by the amount it says.
5. **Simulate.** Typed `ethrex_simulateFrameTransaction`. Gate: a hand-built, throwaway-signed
   SelfVerify transaction (a VERIFY frame with scope `0x3` — a SENDER frame opens no recognized
   prefix) returns `prefixShape: 'SelfVerify'` and a `maxCost` equal to ours. It cannot return
   `valid: true`: the shape is derived after signature authentication, so a recognized shape
   proves decoding and authentication, but a throwaway EOA has no code to call `APPROVE`, and
   the node answers `valid: false, violation: "validation prefix frame reverted"`. A `valid:
   true` gate needs a deployed sender contract and belongs to pass 2.
6. **viem extension.** Gate: `client.extend(frameActions)` reads a frame transaction and its
   three-valued frame receipts through ordinary viem ergonomics.

Deferred to pass 2: broadcast.

## 10. Candidate contributions

Byproducts, each independently useful and none required by the milestones. Recorded here so
they are not lost; whether to file them is the author's call.

1. **viem PR 4486 — frame receipt status collapse.** `transactionReceipt.ts` maps
   `status: fr.status === '0x1' ? 'success' : 'reverted'`, silently reporting every skipped
   frame as reverted. Status is three-valued (`receipt.rs:35`; semantics merged upstream as
   EIPs PR-12061). The same formatter also drops `stateGasUsed`.
2. **`docs/eip-8141.md:78` — stale wire layout.** Documents the pre-composition envelope; a
   builder written from it produces bytes the chain rejects.
3. **`docs/eip-8141.md:362` — stale intrinsic and incomplete formulas.** Says 15000; the
   published figure and the code are 12000. The gas formulas there omit `state_gas_limit` and
   `recent_root_reference_intrinsic_gas`.
4. **Whatever Oracle 3 turns up** that the divergence ledger does not already explain.
5. **`docs/hegota-testnet-spec.md:74` — `debug` listed as served, but refused.** The endpoint
   answers `debug_getRawTransaction` with `-32601 "not available on this endpoint"`. Either the
   page or the proxy is wrong, and a joiner building on raw-bytes retrieval from that page is
   misled. The same report can ask for `eth_getRawTransactionByHash`, which every other client
   serves.

## 11. Open questions

None blocking. Two to settle during implementation, both low-stakes and reversible:

- Whether to depend on viem directly or on `ox`, the lower-level library viem builds on. viem
  is assumed here because the extension surface requires it anyway; `ox` would only reduce the
  core module's dependency weight, and the decision can be deferred until the core is green.
- Whether the `'head'` EIP-8272 envelope change ever needs a serializer. `toHeadShape` covers
  pricing without one; bytes are only justified once that draft stops moving.
