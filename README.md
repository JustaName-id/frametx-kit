# frametx-kit

[![npm](https://img.shields.io/npm/v/%40jaw.id%2Fframetx-kit)](https://www.npmjs.com/package/@jaw.id/frametx-kit)
[![CI](https://github.com/JustaName-id/frametx-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/JustaName-id/frametx-kit/actions/workflows/ci.yml)

TypeScript for **EIP-8141 frame transactions** as hegota-testnet (chain ID `8141`)
actually accepts them: the composed envelope that also carries EIP-8250 keyed nonces
and EIP-8272 recent-root references.

Decode, build, hash, sign, price and dry-run. It does not broadcast.

## Install

```bash
bun add @jaw.id/frametx-kit viem
```

`viem` is a peer dependency, not a bundled one. `frameActions` extends a viem client, so
your client and this library have to be the same viem.

## Use

```ts
import { createPublicClient, http } from 'viem'
import { frameActions } from '@jaw.id/frametx-kit/viem'

const client = createPublicClient({
  transport: http('https://rpc1.privacy.ethrex.xyz'),
}).extend(frameActions)

const tx = await client.getFrameTransaction({ hash })
const receipt = await client.getFrameTransactionReceipt({ hash })
```

Building a transaction? Call `assertValidFrameTx(tx)` before `encodeFrameTx(tx)`. The
encoder itself does not validate, because `sig_hash` is defined over a re-encoding and a
validating encoder would reject the live chain data this library is meant to survey.

```ts
import { assertValidFrameTx, encodeFrameTx, signFrameTx } from '@jaw.id/frametx-kit'

const signed = await signFrameTx(tx, privateKey)
assertValidFrameTx(signed)
const raw = encodeFrameTx(signed)
```

## Two things that will bite you

**Frame receipt status is three-valued** — `'failure'`, `'success'`, `'skipped'`. A
skipped frame never executed and its gas was refunded. It is not a revert.

**The chain's public RPC serves no raw transaction bytes.** `getFrameTransaction` reads
the node's decoded JSON, re-encodes it, and refuses to return anything whose re-encoding
does not reproduce the transaction hash. What you get back is a transaction this library
can put back on the wire byte-for-byte.

## Gas and rule sets

Gas is priced under one of three rule sets, because the deployed binary and the pinned
EIP text disagree:

| Rule set | Meaning |
|---|---|
| `'chain'` | ethrex `31b532266`, what the nodes actually run |
| `'pins'` | the pinned EIP text |
| `'head'` | current drafts, for anticipating the next re-genesis |

```ts
import { compareRuleSets, decodeFrameTx } from '@jaw.id/frametx-kit'
console.log(compareRuleSets(decodeFrameTx(raw), 'chain', 'pins'))
```

`'head'` models only the EIP-8250 change. The head EIP-8272 draft alters the *envelope*,
not just the price, so a reference-carrying transaction has no head-shaped equivalent and
`'head'` throws rather than guessing.

Every gas constant is written as its published figure rather than derived. ethrex's own
suite missed its intrinsic dropping from 15000 to 12000 across 1372 tests by deriving the
expected value from the constant under test.

## Tests

```bash
bun run test        # hermetic, no network
bun run test:live   # hits rpc1.privacy.ethrex.xyz
bun run typecheck
```

The default suite runs entirely off checked-in fixtures. Those are real transactions
captured with `bunx tsx scripts/capture-fixtures.ts`; each records the client version and
genesis hash it was taken against, so a re-genesis fails loudly rather than silently.

## Contributing

Contributions welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — this wire format
has traps, and several things in `src/` that look like code smells are load-bearing.

## Docs

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — architecture, invariants, wire-format traps, how
  the verification oracles work
- [`docs/DESIGN.md`](docs/DESIGN.md) — the binding design spec
- [`docs/OPEN-ITEMS.md`](docs/OPEN-ITEMS.md) — known gaps and unfinished work

## License

MIT
