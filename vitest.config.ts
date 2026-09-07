import { defineConfig } from 'vitest/config'

// The live suite is kept out of the default run by CONFIG, not by a path filter:
// vitest applies `exclude` even when `vitest run test/live` names the directory,
// so an unconditional `exclude: ['test/live/**']` would make `bun run test:live`
// run zero tests and report success.
const live = process.env.FRAMES_LIVE === '1'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: live ? ['**/node_modules/**'] : ['**/node_modules/**', 'test/live/**'],
  },
})
