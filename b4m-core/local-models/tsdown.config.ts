import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing.ts',
    servers: 'src/servers/index.ts',
    'curated-signing': 'src/curatedSigning.ts',
    licenses: 'src/licenses.ts',
    'model-settings': 'src/modelSettings/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
