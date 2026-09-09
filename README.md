# frametx-kit

[![npm](https://img.shields.io/npm/v/%40jaw.id%2Fframetx-kit)](https://www.npmjs.com/package/@jaw.id/frametx-kit)
[![CI](https://github.com/JustaName-id/frametx-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/JustaName-id/frametx-kit/actions/workflows/ci.yml)

TypeScript for **EIP-8141 frame transactions** as hegota-testnet (chain ID `8141`)
actually accepts them: the composed envelope that also carries EIP-8250 keyed nonces
and EIP-8272 recent-root references.

Decode, build, hash, sign, price, dry-run and broadcast.

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

`signFrameTx` also takes an account instead of a key — anything with an `address` and a
raw-digest `sign`, which covers viem's `privateKeyToAccount` and `mnemonicToAccount`, a
`toAccount` source, and your own wrapper around a hardware wallet, an HSM or a remote
signer. It signs every SECP256K1 entry whose `msg` is empty, and refuses if the entry's
resolved signer is not that account's address.

```ts
import { privateKeyToAccount } from 'viem/accounts'

const signed = await signFrameTx(tx, privateKeyToAccount(privateKey))

// a remote signer needs nothing else:
const signed = await signFrameTx(tx, {
  address: '0x…',
  sign: ({ hash }) => myKms.signDigest(hash), // r||s||v, v as 27/28 or a bare 0/1
})
```

A raw-digest `sign` is required. `signMessage` will not do: it EIP-191-prefixes its
argument, so the signature recovers to nothing. A `JsonRpcAccount` (a browser wallet)
cannot sign a raw digest at all — both are refused with an error rather than producing a
transaction the chain silently rejects.

P256 and ARBITRARY entries are left untouched; build those signatures yourself and let
`assertValidFrameTx` check them. `signFrameTx` also handles one signer at a time, so a
transaction with entries for two different signers needs the bytes assembled by hand.

Sending walks the strict path for you — `assertValidFrameTx`, `encodeFrameTx`,
`eth_sendRawTransaction` — and checks that the hash the node returns is `keccak256` of the
bytes it was given. The receipt wait is frame-aware: a skipped frame comes back as
`'skipped'`, not as a revert.

```ts
const hash = await client.sendFrameTransaction({ transaction: signed })
const receipt = await client.waitForFrameTransactionReceipt({ hash })
```

Passing every check here does not guarantee admission. On this chain the VERIFY prefix must
call `APPROVE`, which a plain EOA sender cannot do, so a broadcastable transaction needs a
sender contract and a funded key — both are yours, not this library's. Dry-run with
`client.simulateFrameTransaction({ raw })` before spending.

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

The head EIP-8272 draft alters the *envelope*, not just the price: the recent-root field
is gone and references travel as a leading VERIFY frame against
`0x0000000000000000000000000000000000008272`, 72 bytes each. `compareRuleSets` prices
whichever side names `'head'` over `toHeadShape(tx)`, which applies exactly that change
as a transformation of the transaction, so a reference-carrying transaction is surveyed
rather than refused.

```ts
import { toHeadShape } from '@jaw.id/frametx-kit'
compareRuleSets(tx, 'pins', 'head') // prices the head side over toHeadShape(tx)
toHeadShape(tx) // the same transform on its own; identity when no reference is carried
```

The synthetic frame claims zero execution and state. Zero state is normative: the draft
pins `limits.state` for the recent root verifier frame, along with its mode, target, flags
and value. `limits.execution` is the one figure it leaves open — that falls out of the
`STATICCALL` and one `SLOAD` per tuple — so every limit-derived term of the head price is
still a floor, fine to compare against and wrong to budget with. That is why
`frameTxGas(tx, 'head')` still throws for a reference-carrying transaction rather than
hand you a floor that reads like a budget. `'head'` otherwise prices identically to
`'pins'`; the EIP-8250 change it models is an execution-time charge against
`limits.state`, published as `HEAD_KEYED_NONCE_STATE_GAS`.

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
