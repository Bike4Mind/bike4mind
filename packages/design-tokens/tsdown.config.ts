import { defineConfig } from 'tsdown';

// ESM-only, like the other workspace packages consumed by apps/client.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
