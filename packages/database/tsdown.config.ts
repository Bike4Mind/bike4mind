import { defineConfig } from 'tsdown';

// Entries mirror the package.json exports map - keep the two in sync.
// ESM-only: the CJS interop chain breaks on db-core's default export
// (Node-mode __toESM makes `.default` the whole module.exports), and no CJS
// consumer exists - the package was ESM-only raw TS before this build step.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/models/auth/index.ts',
    'src/models/content/index.ts',
    'src/models/social/index.ts',
    'src/models/billing/index.ts',
    'src/models/ai/index.ts',
    'src/models/infra/index.ts',
  ],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
