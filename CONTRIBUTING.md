# Contributing to frametx-kit

Everything here applies to every contributor, whether you write the code by hand or with
an assistant. If you use an AI tool, point it at this file — `AGENTS.md` and `CLAUDE.md`
exist only to redirect assistants here.

## What this is, and why it exists twice

`frametx-kit` reads, builds, hashes, signs, prices and simulates EIP-8141 frame
transactions as the hegota-testnet chain (chain ID `8141`) accepts them. That envelope is
a composition of three draft EIPs that none of them specifies on its own: EIP-8141
frames, EIP-8250 keyed nonces, EIP-8272 recent-root references.

It is a deliberate second implementation. The reference client is ethrex, on its
`hegota-testnet` branch, and this library exists partly to disagree with it usefully. A
second implementation that hardcodes published figures catches a class of drift that a
derived-constant test suite cannot: ethrex's own suite missed its intrinsic gas dropping
from 15000 to 12000 across 1372 tests, because it derived the expected value from the
constant under test.

If you find that this library and ethrex disagree, that is a result worth reporting, not
a bug to paper over. Open an issue with the transaction hash or byte vector.

## Getting set up

```bash
bun install
```

Use **bun**. `bun.lock` is committed so everyone resolves the same tree; don't commit a
second lockfile. The `scripts` block invokes `vitest` and `tsc` directly, so another
runner will work if you need one.

## Running the checks

```bash
bun run test        # hermetic, no network
bun run test:live   # opt-in, hits rpc1.privacy.ethrex.xyz
bun run typecheck
bun run build       # tsup -> dist/, dual ESM + CJS with both declaration flavours
bunx tsx scripts/capture-fixtures.ts [from-block] [to-block]
```

CI runs `typecheck`, `test`, `build`, and then `@arethetypeswrong/cli --pack .` against
the built package. All four must pass. The live suite is not expected to pass in every
environment and is not a gate.

That last check is there because a broken `exports` map or a mismatched `.d.cts` breaks
every consumer while leaving the test suite entirely green — the tests import from `src/`,
never from `dist/`. If you change `exports`, `files`, `typesVersions` or `tsup.config.ts`,
run `bun run build && bunx @arethetypeswrong/cli --pack .` locally.

The live suite is gated on `FRAMES_LIVE=1` inside `vitest.config.ts`, by config rather
than by a path filter. This is deliberate: vitest applies `exclude` even when a path is
named on the command line, so an unconditional exclude would make `bun run test:live` run
zero tests and report success.

## Rules that are not style preferences

Each of these is load-bearing. Please don't "clean them up".

**Never derive a gas constant from another constant.** Every figure in `src/gas.ts` is
written as its published value, and every expected value in `test/gas.test.ts` is
hand-derived. This is the library's reason to exist, not a magic-number smell.

**Never edit a golden constant or a captured fixture to make a test pass.** `GOLDEN_RLP`
and `GOLDEN_SIG_HASH` are transcribed from ethrex's `frame_tx_wire_tests.rs` and are the
authority; if the encoder disagrees with them, the encoder is wrong. Fixtures under
`test/fixtures/chain/` are captured chain data. A failing oracle is a finding to report.

**`src/gas.ts` must not import `src/envelope.ts`.** The gas model stays independently
testable, so it can be independently wrong or independently right. The small duplication
this causes (a `sameAddress` helper, the framing for two calldata blobs) is deliberate.
`src/envelope.ts` must not import `src/signatures.ts`; the reverse direction is fine.

**`encodeFrameTx` deliberately does not validate.** `frameTxSigHash` is defined over a
re-encoding, so a validating encoder would validate on every hash and on every re-encode
of live chain data in the oracle suite, turning a survey tool into a rejector. The strict
path is `assertValidFrameTx(tx)` then `encodeFrameTx(tx)`.

**`bigint` for every numeric wire field.** `number` is permitted only for `mode` and
`flags`, which are single bytes.

## Traps specific to this wire format

- **Signature layout is `v || r || s`**, `v` at byte 0 as a bare recovery id (0 or 1),
  never 27/28. That is the reverse of viem's layout in both directions. A 27/28-encoded
  signature makes the transaction invalid at consensus, not merely unrelayable.
- **RLP scalars are minimal big-endian**; zero is the empty string `0x`, not `0x00`.
  Never pass viem's `numberToHex` into `toRlp`; use `rlpUint`.
- **`recentRootCalldata` is empty (`0x`) when no reference is declared**, not `toRlp([])`
  (`0xc0`). Getting this wrong adds billed bytes to every transaction on the chain.
- **State gas is added on top of the calldata floor**, never absorbed by it.
- **`limits` is always a two-element list**, including when `state` is zero.
- **The frame's JSON field for the target is `to`, not `target`.** The node's `type` is
  `'0x6'`, one hex digit. Numbers are minimal hex, so zero is `'0x0'`.
- **Frame receipt status is three-valued**: `0` failure, `1` success, `2` skipped.
  Collapsing skipped into reverted is a known defect in other tooling.
- **viem types `client.request` against the client's RPC schema.** A hand-written
  structural client type is not satisfied by a real viem client and `client.extend` will
  not compile. Use `FrameRpcClient` from `src/rpc.ts`.

## What the chain's RPC actually serves

No raw transaction bytes. ethrex has no `eth_getRawTransactionByHash`, and
`debug_getRawTransaction` is refused by the public endpoint despite the network spec page
listing `debug` as exposed. Raw bytes are reconstructed from the node's decoded JSON and
pinned by the transaction hash, which is keccak256 of exactly those bytes.

Historical state is pruned. `ethrex_simulateFrameTransaction` works only against
`latest`; any other block returns `state root missing`.

## Module order

`rlp` / `errors` / `types` → `envelope` → `sighash` → `signatures`. `gas` depends only on
`rlp` and `types`. `rpc` depends only on `errors` and `types`. `viem` sits on top and
holds no logic of its own. `divergence` depends on `gas`. Nothing imports upward.

## Verification

Three oracles, and none of them is self-referential:

1. The golden byte vector and sig-hash, transcribed from ethrex's Rust tests.
2. Re-encoding the node's decoded JSON must reproduce each transaction's hash.
3. Against live receipts: recovered signer equals the *resolved* signer (often not
   `sender` on this chain), our `'chain'` `maxCost` equals the node's, and
   `gasUsed = intrinsic + Σ frame execution + Σ frame state`.

Run the commands and read the output before concluding that something works.

The `v || r || s` byte order deserves a note, because a round-trip test cannot pin it: a
mirrored error in the encoder and the decoder survives one. It is pinned instead by
hand-constructed byte-pattern assertions and by oracle 3 recovering signers from real
ethrex-produced signatures. Hold any new layout you add to the same standard.

## Commits, PR titles and releases

This repository releases automatically once it has been released once. Merging to `main`
runs [semantic-release](https://semantic-release.gitbook.io/), which reads the commit
history, decides the next version, writes `CHANGELOG.md`, tags the commit, creates the
GitHub release, and publishes `@jaw.id/frametx-kit` to npm.

The very first publish is manual, from **Actions → Release → Run workflow**: until a `v*`
tag exists, a push to `main` deliberately publishes nothing. That first run publishes the
`version` currently in `package.json` (`0.0.1`) and tags it; semantic-release takes over
from there.

That means **your commit messages set the version**. Use
[Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Effect |
|---|---|
| `fix: …` | patch release |
| `feat: …` | minor release |
| `feat!: …` or a `BREAKING CHANGE:` footer | major release |
| `docs:`, `chore:`, `test:`, `ci:`, `refactor:`, `style:`, `perf:`, `build:`, `revert:` | no release |

Pull request titles are validated by CI against that list, with an optional scope from
`envelope`, `sighash`, `signatures`, `gas`, `divergence`, `rlp`, `rpc`, `viem`,
`fixtures`, `docs`, `deps`, `ci`, `repo` — for example
`feat(gas): model the head EIP-8272 reference arm`. Subjects start lowercase.

Do not hand-edit `version` in `package.json` or touch `CHANGELOG.md`; the release commit
owns both. A wire-format or gas change is almost always at least a `fix:`, because
someone downstream is encoding bytes with this.

## Submitting a change

- Branch from `main`, keep the change focused.
- `bun run test` and `bun run typecheck` both clean.
- New wire-format or gas behaviour needs a test that could actually fail — pinned to a
  published figure, a golden vector, or captured chain data, not to the code's own output.
- If you touched anything in **Rules that are not style preferences**, say why in the PR
  description. Those changes are not refused, but they are argued.
- Fixtures expire. They record the client version and genesis hash they were captured
  against and the oracle suite asserts the genesis hash, so a re-genesis fails loudly.
  This chain is already on its third genesis; re-capture with the script rather than
  hand-editing.

## Where the rest of the docs are

- `docs/DESIGN.md` — the binding design spec. It is the authority on intended behaviour;
  where the code and the spec disagree, that is a bug in one of them, so say which.
- `docs/OPEN-ITEMS.md` — known gaps and unfinished work.
- `README.md` — user-facing API.
