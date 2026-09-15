import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/apiKeyService/index.ts',
    'src/mfaService/index.ts',
    'src/mfaService/utils.ts',
    'src/crypto.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
