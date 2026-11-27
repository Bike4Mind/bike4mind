import { defineConfig } from 'tsdown';
import { bundleProblems, type BundleChunk } from './src/verifyBundle.ts';

/** Fails the build unless the output is one file that imports only Node built-ins and fits the size budget. */
function verifyBundlePlugin() {
  return {
    name: 'verify-model-host-bundle',
    generateBundle(_options: unknown, bundle: Record<string, { type: string } & Partial<BundleChunk>>) {
      const chunks = Object.values(bundle).filter(output => output.type === 'chunk') as BundleChunk[];
      const problems = bundleProblems(chunks);
      if (problems.length) throw new Error(`b4m-host bundle check failed:\n  ${problems.join('\n  ')}`);
    },
  };
}

export default defineConfig({
  entry: { 'b4m-host': 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  deps: {
    alwaysBundle: [/.*/],
    // Workspace packages resolve outside node_modules, so only npm packages are listed.
    onlyBundle: ['zod'],
    onlyImport: [],
  },
  outputOptions: { codeSplitting: false },
  plugins: [verifyBundlePlugin()],
});
