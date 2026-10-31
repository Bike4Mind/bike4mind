import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing.ts', servers: 'src/servers/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
