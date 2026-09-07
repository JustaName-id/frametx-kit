import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    viem: 'src/viem.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // viem stays external: consumers bring their own, and bundling it would
  // duplicate its secp256k1 and keccak implementations.
  external: ['viem'],
})
