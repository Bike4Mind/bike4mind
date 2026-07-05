import { defineConfig } from 'tsdown';
import { cpSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: [
    'src/index.tsx',
    'src/commands/mcpCommand.ts',
    'src/commands/updateCommand.ts',
    'src/commands/doctorCommand.ts',
    'src/commands/headlessCommand.ts',
    'src/commands/apiCommand.ts',
    'src/commands/envCommand.ts',
  ],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Brand defaults baked into the published binary at build time - NO brand
  // fallback in source (open-core invariant): a fresh clone
  // ships empty, so the upstream literal never enters a fork's bundle. The hosted
  // publish injects these from repo variables in the build step (release.yaml /
  // snapshot-publish.yaml); a fork sets B4M_DEFAULT_API_URL / B4M_CREDITS_URL when
  // building to publish under its own brand.
  env: {
    B4M_DEFAULT_API_URL: process.env.B4M_DEFAULT_API_URL ?? '',
    B4M_CREDITS_URL: process.env.B4M_CREDITS_URL ?? '',
  },
  // Keep all npm packages external (will be installed via package.json dependencies)
  // Bundle @bike4mind/* workspace packages into the CLI
  deps: {
    neverBundle: [
      /^(?![\.\/])[^@]/, // Non-scoped packages (not file paths): axios, uuid, etc.
      /^@(?!bike4mind\/)/, // Scoped packages except @bike4mind/*: @aws-sdk/*, etc.
    ],
  },
  // Copy agent markdown files to dist after build
  onSuccess: async () => {
    const src = resolve(__dirname, 'src/agents/defaults');
    const dest = resolve(__dirname, 'dist/agents/defaults');
    cpSync(src, dest, { recursive: true });
    console.log('Copied agent definitions to dist/agents/defaults');
  },
});
