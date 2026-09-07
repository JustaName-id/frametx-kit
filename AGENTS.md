# AGENTS.md

Instructions for AI coding assistants. Any tool that reads `AGENTS.md`, `CLAUDE.md` or an
equivalent should start here.

**Read `CONTRIBUTING.md` first.** It is the real documentation — architecture, invariants,
wire-format traps, and how the three verification oracles work — and it is written for
every contributor, not just for assistants. This file adds nothing except a short list of
the things a well-meaning assistant is most likely to break.

## Do not "clean up" any of these

They look like code smells. They are load-bearing. `CONTRIBUTING.md` explains each one.

- **Do not derive a gas constant from another constant**, and do not replace a
  hand-derived expected value in `test/gas.test.ts` with a computed one. Duplication of
  published figures is the point of the library.
- **Do not edit `GOLDEN_RLP`, `GOLDEN_SIG_HASH`, or anything under
  `test/fixtures/chain/` to make a test pass.** They are the oracle. If the code
  disagrees with them, the code is wrong, and a failing oracle is a finding to report.
- **Do not make `src/gas.ts` import `src/envelope.ts`** to remove the duplicated
  `sameAddress` helper or calldata framing. The independence is deliberate.
- **Do not wire validation into `encodeFrameTx`.** `assertValidFrameTx` is the strict
  path, called separately.
- **Do not use `number` for a numeric wire field.** `bigint` everywhere except `mode` and
  `flags`.
- **Do not add an unconditional `exclude` for the live tests in `vitest.config.ts`.** The
  `FRAMES_LIVE` gate is conditional because vitest applies `exclude` even to a named path,
  which would make the live suite pass by running nothing.

## Working here

- Use **bun**. Not npm, not pnpm, and do not commit a second lockfile.
- Run `bun run test` and `bun run typecheck` and read the output before reporting that
  something works. Reasoning about this wire format is not a substitute for running the
  oracles against it.
- `docs/DESIGN.md` is binding. If the code contradicts it, say which one you think is
  wrong rather than silently matching the code.
- Commit messages are Conventional Commits and they set the published version — a
  released `fix:` or `feat:` is not a formatting choice. Never edit `version` in
  `package.json` or `CHANGELOG.md`; the release automation owns both.
- The test suite imports from `src/`, never from `dist/`, so it cannot catch a broken
  `exports` map. After touching `exports`, `files`, `typesVersions` or `tsup.config.ts`,
  run `bun run build && bunx @arethetypeswrong/cli --pack .`.
