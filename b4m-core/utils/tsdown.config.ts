import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/artifactParser.ts',
    'src/llm/backend.ts',
    'src/escapeRegex.ts',
    'src/registrableDomain.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
