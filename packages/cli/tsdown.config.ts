import { defineConfig } from 'tsdown';
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { builtinModules } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build-time guard against the "bundled workspace package pulled in an npm dep
 * that the CLI never declared" class of bug (e.g. @bike4mind/utils importing
 * `tldts`). We bundle @bike4mind/* inline but keep npm packages external, so
 * every external the emitted bundle references MUST resolve from the CLI's own
 * node_modules - otherwise the published binary dies at startup with
 * ERR_MODULE_NOT_FOUND. This reproduces that resolution at build time and fails
 * the build instead of the user's machine.
 */
function verifyExternalsAreResolvable(distDir: string, pkgDir: string) {
  const builtins = new Set(builtinModules);

  const mjsFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.mjs')) mjsFiles.push(full);
    }
  };
  walk(distDir);

  // Extract module specifiers from the emitted (non-minified) ESM bundle. Each
  // regex is anchored to a real statement form so we don't match method calls
  // like `Buffer.from('x')` or string literals that merely contain `from`:
  //   - `import ... from '...'` / `export ... from '...'` (single-line, as rolldown emits)
  //   - side-effect `import '...'`
  //   - dynamic `import('...')`
  //   - residual `require('...')`
  const specifierPatterns = [
    /(?:^|[;\n\r{}])\s*(?:import|export)\b[^;\n\r]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\n\r{}])\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  const packageNameOf = (spec: string) =>
    spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

  const resolvableFromCli = (pkgName: string) => {
    let dir = pkgDir;
    // Walk up node_modules chains, matching Node's own resolution.
    for (;;) {
      if (existsSync(join(dir, 'node_modules', pkgName, 'package.json'))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  };

  const missing = new Map<string, string>(); // package name -> first file that imports it
  for (const file of mjsFiles) {
    const code = readFileSync(file, 'utf8');
    for (const pattern of specifierPatterns) {
      for (const match of code.matchAll(pattern)) {
        const spec = match[1];
        // Skip relative paths, absolute paths, and scheme-prefixed specifiers (node:, data:, etc.).
        if (spec.startsWith('.') || spec.startsWith('/') || spec.includes(':')) continue;
        const pkgName = packageNameOf(spec);
        if (builtins.has(pkgName)) continue;
        if (missing.has(pkgName) || resolvableFromCli(pkgName)) continue;
        missing.set(pkgName, file);
      }
    }
  }

  if (missing.size > 0) {
    const details = [...missing.entries()]
      .map(([pkg, file]) => `  - ${pkg} (from ${file.replace(pkgDir + '/', '')})`)
      .join('\n');
    throw new Error(
      `tsdown: ${missing.size} external import(s) in the CLI bundle cannot be resolved from ` +
        `packages/cli/node_modules:\n${details}\n\n` +
        `These are almost certainly transitive deps of a bundled @bike4mind/* package. ` +
        `Add each to "dependencies" in packages/cli/package.json (see the neverBundle note above).`
    );
  }
}

export default defineConfig({
  entry: [
    'src/index.tsx',
    'src/commands/mcpCommand.ts',
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

    verifyExternalsAreResolvable(resolve(__dirname, 'dist'), __dirname);
    console.log('Verified all external bundle imports resolve from packages/cli/node_modules');
  },
});
