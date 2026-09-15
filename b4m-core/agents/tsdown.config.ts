import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/toolFormat.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
