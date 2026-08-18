import { defineConfig } from 'tsdown';
import { cpSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { collectGraphSpecifiers, findUndeclaredBundleDeps } from './src/verifyBundleExternals.ts';
import type { ModuleGraph } from './src/verifyBundleExternals.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build-time guard against the "bundled workspace package pulled in an npm dep
 * that the CLI never declared" class of bug (e.g. @bike4mind/utils importing
 * `tldts`). We bundle @bike4mind/* inline but keep npm packages external, so
 * every external the emitted bundle references MUST be a declared production
 * dependency of the CLI - otherwise the published binary dies at startup with
 * ERR_MODULE_NOT_FOUND once npm installs only the declared closure.
 *
 * Walks rolldown's module graph (external imports keep their bare-specifier id;
 * internal modules are absolute paths) rather than pattern-matching emitted
 * source, and validates against packages/cli/package.json's declared deps rather
 * than whatever happens to be resolvable on the build machine (a hoisted-but-
 * undeclared transitive dep would otherwise pass). Fails the build, not the user.
 */
function verifyBundleExternalsPlugin(pkgDir: string) {
  return {
    name: 'verify-bundle-externals',
    // generateBundle (an output hook) rather than buildEnd: tsdown only invokes
    // user plugins' output hooks, and generateBundle's PluginContext still
    // exposes the full module graph via getModuleIds()/getModuleInfo().
    generateBundle() {
      const ctx = this as unknown as ModuleGraph;
      const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const declaredDeps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
      ]);

      const specifiers = collectGraphSpecifiers(ctx);

      // Fail loud if the graph walk found nothing: the guard would silently pass
      // (and stop guarding) if rolldown's plugin-context shape ever drifts and the
      // `this as ModuleGraph` cast starts resolving to an empty/incompatible object.
      if (specifiers.size === 0) {
        throw new Error(
          'tsdown: verify-bundle-externals found an empty module graph - the ' +
            'generateBundle PluginContext API may have changed. The guard is not running.'
        );
      }

      const missing = findUndeclaredBundleDeps(specifiers, declaredDeps);
      if (missing.length > 0) {
        throw new Error(
          `tsdown: ${missing.length} external import(s) in the CLI bundle are not declared in ` +
            `packages/cli/package.json "dependencies":\n` +
            missing.map(dep => `  - ${dep}`).join('\n') +
            `\n\nThese are almost certainly transitive deps of a bundled @bike4mind/* package. ` +
            `Add each to "dependencies" so a fresh install of @bike4mind/cli can resolve them ` +
            `(see the neverBundle note below).`
        );
      }
    },
  };
}

export default defineConfig({
  entry: [
    'src/index.tsx',
    'src/commands/mcpCommand.ts',
    'src/commands/pluginCommand.ts',
    'src/commands/updateCommand.ts',
    'src/commands/doctorCommand.ts',
    'src/commands/headlessCommand.ts',
    'src/commands/acpCommand.ts',
    'src/commands/apiCommand.ts',
    'src/commands/envCommand.ts',
  ],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  plugins: [verifyBundleExternalsPlugin(__dirname)],
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
