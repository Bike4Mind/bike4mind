import { defineConfig } from 'tsdown';

export default defineConfig([
  // Library exports (ESM + CJS with type declarations)
  {
    entry: ['src/index.ts', 'src/atlassian/constants.ts', 'src/github/constants.ts', 'src/notion/constants.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist',
    clean: false,
  },
  // MCP server scripts (ESM only - these use top-level await)
  {
    entry: ['src/atlassian/index.ts', 'src/github/index.ts', 'src/linkedin/index.ts', 'src/notion/index.ts'],
    format: ['esm'],
    dts: false,
    outDir: 'dist',
  },
]);
