#!/usr/bin/env node

// Bundles every Lambda handler that infra/ declares, with esbuild, and fails if
// any of them will not bundle.
//
// Nothing else in CI runs esbuild over the handlers: `sst build` does not exist
// (sst 4.17.1 has no such command) and `sst diff` reads the state passphrase out
// of SSM before it evaluates a single resource, so it cannot run without AWS
// credentials. Until this guard, the first thing to bundle a handler after a
// dependency change was a real deploy - a preview if the PR had one, otherwise
// staging. A pnpm-lock.yaml change does not trip the preview gate, so
// dependency PRs reached staging unbundled.
//
// This is a replica of sst's bundling step, not sst's own bundler: sst builds
// each Function separately through its Go CLI with esbuild v0.27.2 embedded,
// and this runs one esbuild pass with the repo's own pin. What it reproduces is
// module resolution and ESM/CJS linking over the same entry points, which is
// where a dependency change breaks the bundle. Verified against the 2026-09-16
// staging outage: with the pre-fix @smithy/core pin restored, this reports
// `No matching export ... for import "hasOwn"` and exits 1.
//
// Usage: pnpm turbo:core:build && node scripts/check-lambda-bundle.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// sst's node runtime always externalizes these two; everything else comes from
// sst.config.ts so the two lists cannot drift. Not readable from the vendored JS
// package - the bundling lives in sst's Go binary - so this is read off that
// binary's string table, next to the other esbuild option names it sets.
export const SST_BUILTIN_EXTERNAL = ['sharp', 'pg-native'];

// Handler paths under here are re-exported from a premium overlay and only
// exist once the overlay is hydrated. Absent in this repo by design.
const OVERLAY_HANDLER_DIR = 'premium-generated/';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

// Every handler in infra/ is a plain string literal of the form
// `path/to/file.exportName`. collectHandlers asserts that stays true.
// The lookbehind keeps a `somethinghandler:` key from being read as an entry
// point; `Handler:` in another case never matches in the first place.
const HANDLER_PATTERN = /(?<![A-Za-z])handler:\s*(['"`])([^'"`\n]+)\1/g;
const ANY_HANDLER_KEY = /(?<![A-Za-z])handler:/g;

// sst.config.ts registers these as external on EVERY Function via $transform.
// Read rather than copied: a fourth entry added there has to reach this guard,
// and a guard that silently missed one would redden on an unrelated PR.
//
// Per-Function externals are deliberately NOT applied: `infra/mcp.ts` keeps
// `@bike4mind/mcp` / `@bike4mind/common` plus its `install` list out of its
// bundle, and `infra/queues.ts` repeats `isolated-vm` that ALWAYS_EXTERNAL
// already covers. Inlining those bundles more than a deploy does, which is more
// resolution coverage - but it cuts the other way too: a package that only works
// kept external would fail here and deploy fine. That is the false red to expect,
// and this list is where to add the package when it happens.
export function parseAlwaysExternal(configSource) {
  const match = /const ALWAYS_EXTERNAL = \[([^\]]*)\]/.exec(configSource);
  if (!match) {
    throw new Error(
      'Could not find `const ALWAYS_EXTERNAL = [...]` in sst.config.ts. It registers the externals that apply to every Function; this guard reads it so the two cannot drift. If it was renamed or moved, update parseAlwaysExternal in scripts/check-lambda-bundle.mjs to match.'
    );
  }
  return [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
}

export function listInfraSources(infraDir) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(infraDir);
  return out.sort();
}

// Comments have to be gone before either pattern runs. "handler" is a common
// word in exactly this codebase, and infra/ already carries `* Handler:` in
// JSDoc and `// Handler:` in a line comment - lowercase any one of those and a
// raw-text scan either hard-fails with a wrong diagnosis or extracts the
// comment's example path as a real entry point. esbuild is the tokenizer
// because it is already the thing doing the bundling, and unlike a line filter
// it handles JSDoc, trailing comments, and `//` inside a string literal.
export function stripComments(source, file = 'infra.ts') {
  return esbuild.transformSync(source, {
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
    legalComments: 'none',
  }).code;
}

// Returns [{ handler, declaredIn }], deduped, in declaration order.
export function collectHandlers(sources, readFile = f => fs.readFileSync(f, 'utf8')) {
  const seen = new Map();
  for (const file of sources) {
    const source = stripComments(readFile(file), file);

    // A handler built from a variable would be invisible to the pattern above and
    // would drop a Lambda out of this guard with nothing to show for it.
    const literalCount = [...source.matchAll(HANDLER_PATTERN)].length;
    const totalCount = [...source.matchAll(ANY_HANDLER_KEY)].length;
    if (literalCount !== totalCount) {
      throw new Error(
        `${file} declares a handler that is not a string literal. This guard finds entry points by reading those literals, so a computed handler is a Lambda it cannot bundle. Either keep the literal or add the entry point to this guard explicitly.`
      );
    }

    for (const [, , handler] of source.matchAll(HANDLER_PATTERN)) {
      if (!seen.has(handler)) seen.set(handler, file);
    }
  }
  return [...seen].map(([handler, declaredIn]) => ({ handler, declaredIn }));
}

// `path/to/file.exportName` -> the source file, or null when nothing matches.
export function resolveHandlerFile(root, handler, exists = p => fs.existsSync(p)) {
  const dot = handler.lastIndexOf('.');
  if (dot <= 0) return null;
  const base = handler.slice(0, dot);
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (exists(path.join(root, candidate))) return candidate;
  }
  return null;
}

export function isOverlayHandler(handler) {
  return handler.includes(OVERLAY_HANDLER_DIR);
}

// Splits declared handlers into what this repo can bundle, what is overlay-only,
// and what is simply broken. A missing file outside the overlay path is a typo
// or a deleted handler and must fail.
export function planEntryPoints(root, handlers, exists) {
  const entries = [];
  const skipped = [];
  const missing = [];
  for (const { handler, declaredIn } of handlers) {
    const file = resolveHandlerFile(root, handler, exists);
    if (file) entries.push({ handler, file, declaredIn });
    else if (isOverlayHandler(handler)) skipped.push({ handler, declaredIn });
    else missing.push({ handler, declaredIn });
  }
  return { entries, skipped, missing };
}

// Without splitting, esbuild repeats the same failure once per entry point that
// reaches it - 768 lines for the 8 distinct breakages behind them. Splitting
// already collapses most of that; this is the belt to its braces.
export function dedupeMessages(messages) {
  const byKey = new Map();
  for (const message of messages) {
    const where = message.location ? `${message.location.file}:${message.location.line}` : '';
    const key = `${message.text}@@${where}`;
    if (!byKey.has(key)) byKey.set(key, { text: message.text, where, count: 0 });
    byKey.get(key).count += 1;
  }
  return [...byKey.values()];
}

// One esbuild pass over every entry point. Returns the raw esbuild messages and
// the resolved-module count; the caller decides what that means.
export async function bundleEntryPoints({ root, files, external }) {
  const result = await esbuild
    .build({
      absWorkingDir: root,
      entryPoints: files,
      bundle: true,
      // Nothing is written: the guard is a build, not an artifact producer, and a
      // CI job that leaves the tree dirty is its own problem.
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      target: 'esnext',
      mainFields: ['module', 'main'],
      keepNames: true,
      external,
      // Required for path computation under `splitting`; `write: false` means it
      // is never created. Under node_modules so a future `write: true` debug run
      // still cannot dirty the tree.
      outdir: path.join(root, 'node_modules', '.cache', 'lambda-bundle-check'),
      logLevel: 'silent',
      // Code splitting is what makes this affordable. Without it esbuild emits a
      // standalone bundle per handler and spends ~3 minutes printing 2.5 GB of
      // duplicated output; with it the same 9,902 modules are resolved and linked
      // in ~2 seconds. The input graph is identical either way, which is the only
      // part this guard reads.
      splitting: true,
    })
    .catch(error => error);

  return {
    errors: result.errors ?? [],
    modules: result.metafile ? Object.keys(result.metafile.inputs).length : 0,
  };
}

async function main() {
  const infraDir = path.join(repoRoot, 'infra');
  const handlers = collectHandlers(listInfraSources(infraDir));
  const { entries, skipped, missing } = planEntryPoints(repoRoot, handlers);

  if (missing.length) {
    console.error('ERROR: infra/ declares Lambda handlers whose source file does not exist:');
    for (const { handler, declaredIn } of missing) {
      console.error(`  ${handler}  (declared in ${path.relative(repoRoot, declaredIn)})`);
    }
    process.exit(1);
  }

  if (!entries.length) {
    console.error(
      'ERROR: found no Lambda handlers under infra/. The guard would report success having bundled nothing.'
    );
    process.exit(1);
  }

  const external = [
    ...new Set([
      ...SST_BUILTIN_EXTERNAL,
      ...parseAlwaysExternal(fs.readFileSync(path.join(repoRoot, 'sst.config.ts'), 'utf8')),
    ]),
  ];

  console.log(`Bundling ${entries.length} Lambda handlers declared in infra/`);
  if (skipped.length) {
    console.log(`Skipping ${skipped.length} overlay-only handlers (source arrives with the premium overlay):`);
    for (const { handler } of skipped) console.log(`  ${handler}`);
  }
  console.log(`External: ${external.join(', ')}`);

  const started = Date.now();
  const { errors, modules } = await bundleEntryPoints({
    root: repoRoot,
    files: entries.map(e => e.file),
    external,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (errors.length) {
    const distinct = dedupeMessages(errors);
    console.error(
      `\nERROR: ${distinct.length} distinct bundling failure(s) across ${entries.length} handlers (${elapsed}s):\n`
    );
    for (const { text, where, count } of distinct) {
      console.error(`  ${text}`);
      if (where) console.error(`    at ${where}`);
      if (count > 1) console.error(`    reported ${count} times`);
    }
    console.error(
      '\nThese handlers will not bundle, so `sst deploy` fails for every stage. A dependency change is the usual cause: a package dropped an export, changed its ESM/CJS shape, or a pnpm override now resolves a version below what its consumers import.'
    );
    process.exit(1);
  }

  console.log(`\nOK: ${entries.length} handlers bundled, ${modules} modules resolved, ${elapsed}s`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
