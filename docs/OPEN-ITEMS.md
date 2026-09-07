# frametx-kit — open items

Known gaps and unfinished work, current as of ethrex `hegota-testnet` @ `19c065fa8`.
The invariants and wire-format traps are in `../CONTRIBUTING.md`; `DESIGN.md` is the
binding spec.

Nothing here is blocking. In rough priority order:

- **Spec §7 promises `FrameDecodeError` carries "the byte offset at which parsing
  failed".** viem's `fromRlp` does not expose one, so the delivered offset is a constant
  0 or 1. Either hand-roll an RLP walker or drop the promise from the spec — a misleading
  offset is worse than none.
- **`'head'` models only the EIP-8250 gas change.** For a reference-carrying transaction
  it throws rather than guessing, because the head EIP-8272 draft removes the envelope
  field entirely. Implementing the head reference arm as a gas-only computation is the
  natural next step, and the spec explicitly allows it without a second serializer.
- **Fixture coverage gaps that are facts about the chain, not omissions:** no captured
  transaction uses signature scheme 2 (P256) or a targetless value-carrying frame — the
  latter is the only shape where `'chain'` and `'pins'` diverge, so the divergence survey's
  positive branch is exercised only offline. Scheme 0 (ARBITRARY) and frame mode 0 *are*
  covered, both by
  `test/fixtures/chain/0xa5176324860de896e541bb12914e086f95bd6dadd12679cea1c57b9c51c856be.json`
  (block 42,241): two mode-0 frames and a single 24,820-byte ARBITRARY signature.
  Re-run `bunx tsx scripts/capture-fixtures.ts` when the chain produces a transaction
  covering one of the remaining gaps.
- **Fixtures expire.** They record the client version and genesis hash they were taken
  against, and the oracle suite asserts the genesis hash, so a re-genesis fails loudly
  rather than silently. This chain is already on its third genesis.
- **Two upstream documentation bugs worth reporting.** ethrex's
  `docs/eip-8141.md` still documents the pre-composition wire layout and an intrinsic of
  15000 (the published figure and the code are both 12000), and
  ethrex's `docs/hegota-testnet-spec.md` lists `debug` among the namespaces served by
  `rpc1.privacy.ethrex.xyz` while the endpoint actually refuses `debug_getRawTransaction`.
  Anyone implementing from either document would be misled.
