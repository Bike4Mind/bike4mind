#!/usr/bin/env node
// Fails the build when a BUILT API route cannot be LOADED at module load.
//
// Failure class: a module-load resolution failure in the compiled route. The motivating case is
// ERR_REQUIRE_ESM - an ESM-only package reached by a real require() from the CommonJS route
// bundle - but a module that does not resolve at all (MODULE_NOT_FOUND, ERR_MODULE_NOT_FOUND,
// ERR_PACKAGE_PATH_NOT_EXPORTED) is the same production symptom. Next has not started the
// handler and has not run auth middleware, so the caller gets a framework HTML 500 before any
// app code runs - and every unit test stays green, because vitest imports the source as ESM and
// never exercises a real require(). This probe loads the compiled route, so the bundler's
// bundled-vs-externalized decision is the thing under test.
//
// Scope: the SELF-HOST image only. This runs against the `output: 'standalone'` tree Turbopack
// emits for the self-host builder (B4M_SELF_HOST=true). The hosted/OpenNext build externalizes
// traced modules into a Lambda layout this repo does not produce at PR time, so that layout is
// NOT covered here; the deployer is where that gap can be closed. The sanitize-html/htmlparser2
// case that motivated the guard is defused upstream in this repo by the transpilePackages entry
// (apps/client/next.config.mjs, pinned by packages/scripts/src/checkSanitizeHtmlTranspile.test.ts)
// plus the dual-published-htmlparser2 override; this probe is the built-artifact check that would
// catch either mitigation being dropped.
//
// Why the built module and not reachability from pages/api/**: reachability is ~100% false
// positives here - Turbopack bundles most ESM-only dependencies into the route chunk, so only
// the ones it actually leaves external can throw, and no static scan can know which. Requiring
// the built file is the same resolution the deployed server performs.
//
// Why --no-experimental-require-module: this is the mode the failure was reproduced in. Passing
// without require(esm) is the stronger guarantee - a dual-published package resolves its
// "require" condition to a CommonJS file and cannot throw under any Node or bundler, rather than
// depending on require(esm) engaging in whatever context the route is loaded from.
//
// Why here: the self-host image workflow already runs a real `next build` on every PR that
// touches the app, and its builder stage already hosts the post-build guards (pruneTestRoutes.mjs,
// check-standalone-tree.mjs). The probe itself is not free: loading all ~812 routes took ~2
// minutes wall / ~20 CPU-minutes on a 14-core host, plus a temporary copy of the standalone tree
// (hundreds of MB, removed before the layer commits) - a few minutes on a CI runner, no new build.
//
// Turbopack reports an external module's load failure as a rejection whose message WRAPS the
// underlying error code ("Failed to load external module <name>: Error [ERR_REQUIRE_ESM]: ..."),
// so classification reads the code out of the message too, not just off `error.code`. It also
// emits the route as an async module, so the probe awaits the exports promise instead of trusting
// a fixed window started at require().
//
// The builder runs this with --env-file=.env.selfhost.example: without runtime env the resource
// shim throws at load for most routes (it reads required vars eagerly), which both masks any
// real resolution failure behind that throw and would make the guard blind. A route that still
// aborts on missing config is therefore a FAILURE, not a warning - an env-masked route is an
// unprobed route, and a missing key in the template is itself a self-host defect.
//
// Usage: node --env-file=.env.selfhost.example apps/client/scripts/check-api-routes-cjs-require.mjs <standalone root> <.next dir relative to it>
// The tree is copied outside the builder before probing, so a module missing from the standalone
// trace cannot resolve through the builder's own node_modules.
// Exit 1 on any load failure, or when zero routes are found (the guard cannot pass silently).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FAIL = 'fail';
export const WARN = 'warn';
export const PASS = 'pass';

// Resolution failures that make a shipped route unreachable. ERR_REQUIRE_ESM is the motivating
// case; the rest are a module the tree cannot resolve at load. An env var or a network hiccup is
// NOT in this set and stays a warning.
export const LOAD_FAILURE_CODES = new Set([
  'ERR_REQUIRE_ESM',
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

// The resource shim's message (b4m-core/resource/src/index.ts). A route that dies on this never
// reached its own requires, so the probe learned nothing about it.
export const SELF_HOST_CONFIG_MISSING = 'Self-host config missing';

// A route module may itself write to stdout at load, so the child tags its report and the parent
// extracts the last tagged line rather than parsing the whole stream.
const REPORT_MARKER = '@@API_ROUTE_PROBE@@';

// Loader run in a child per route. require() is synchronous; when Turbopack emits the route as an
// async module the loader awaits the exports promise (below), so an externalized import that
// rejects after the module returns is caught, with an unhandledRejection backstop. The explicit
// exits keep a route's DB/SDK handles from holding the child open; the parent's timeout is the
// backstop for a route that never settles (a FAIL, labelled with the elapsed limit).
const CHILD_SCRIPT = `
const file = process.argv[1];
const write = (report) => {
  process.stdout.write(${JSON.stringify(REPORT_MARKER)} + JSON.stringify(report) + '\\n');
};
let reported = false;
const report = (error) => {
  if (reported) return;
  reported = true;
  const code = error && error.code;
  const message = error && error.message ? String(error.message) : String(error);
  write({ loaded: false, code, message });
  process.exit(0);
};
process.on('unhandledRejection', (error) => report(error));
let exported;
try {
  exported = require(file);
} catch (error) {
  report(error);
}
// A short settle after the module settles, so a rejection from a nested async-module promise
// (which the runtime .catch()es, hiding it from unhandledRejection) still lands here.
const settle = () => {
  setTimeout(() => {
    write({ loaded: true });
    process.exit(0);
  }, 25);
};
// Turbopack emits these routes as async modules: require() returns the exports as a Promise,
// and the external-module throw surfaces as a rejection only after the route's awaited ESM
// imports resolve - often hundreds of ms later. Await the exports promise so it is caught;
// a fixed window started at require() would read the route as clean.
if (exported && typeof exported.then === 'function') {
  exported.then(settle, report);
} else {
  settle();
}
`;

/**
 * Relative POSIX paths of every compiled API route module under <nextDir>/server/pages/api.
 * Skips Next's non-route sidecars (.js.nft.json, .js.map), test routes (pruned before this runs,
 * but kept out defensively), and anything outside pages/api.
 */
export function listApiRouteModules(nextDir) {
  const apiRoot = path.join(nextDir, 'server', 'pages', 'api');
  if (!fs.existsSync(apiRoot)) return [];
  const found = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
      found.push(path.relative(nextDir, full).split(path.sep).join('/'));
    }
  };
  walk(apiRoot);
  return found;
}

/** `server/pages/api/foo/index.js` -> `/api/foo`; `server/pages/api/foo.js` -> `/api/foo`. */
export function routePathForModule(moduleRelPath) {
  let route = moduleRelPath.startsWith('server/pages/') ? moduleRelPath.slice('server/pages/'.length) : moduleRelPath;
  route = route.replace(/\.js$/, '');
  if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
  return `/${route}`;
}

/**
 * The package a file path belongs to: the segment after the LAST node_modules (pnpm-aware),
 * scoped-aware. Turbopack's externalized modules live in `.next/node_modules/<name>-<16 hex>`;
 * that disambiguating hash is stripped so the named package is the real one.
 */
export function packageNameFromPath(filePath) {
  const normalized = String(filePath).split(path.sep).join('/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const segments = normalized.slice(index + marker.length).split('/');
  if (!segments[0]) return null;
  const stripHash = (name) => name.replace(/-[0-9a-f]{16}$/, '');
  if (segments[0].startsWith('@')) return segments.length >= 2 && segments[1] ? `${segments[0]}/${stripHash(segments[1])}` : null;
  return stripHash(segments[0]);
}

/** The code of a load failure, read off `error.code` OR out of a wrapping message. */
export function findLoadFailureCode({ code, message } = {}) {
  if (code && LOAD_FAILURE_CODES.has(code)) return code;
  const text = String(message ?? '');
  for (const candidate of LOAD_FAILURE_CODES) {
    if (text.includes(candidate)) return candidate;
  }
  // Node's un-wrapped CJS shape carries no code in some paths; the phrase is the signal.
  if (/Cannot find (?:module|package) /.test(text)) return 'MODULE_NOT_FOUND';
  return null;
}

/** The first path on Node's "Require stack:" list, or undefined. */
function requireStackEntry(message) {
  const lines = String(message ?? '').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Require stack:');
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*-\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return undefined;
}

/**
 * Names the offending package and its requirer out of a load-failure message. Handles Node's
 * ERR_REQUIRE_ESM ("require() of ES Module <esm> from <requirer> not supported."), its
 * "Cannot find module/package" shapes (with an optional Require stack), and Turbopack's wrapper
 * that embeds the original message verbatim. Best-effort: classification is by failure code, so
 * a message shape change degrades the label, never the gate.
 * Returns { missingPackage, requiredFrom } - either may be null.
 */
export function describeLoadError(message) {
  const text = String(message ?? '');

  const esm = text.match(/require\(\) of ES Module (.*?) from (.*?) not supported\./);
  if (esm) {
    return {
      missingPackage: packageNameFromPath(esm[1]) ?? esm[1],
      requiredFrom: packageNameFromPath(esm[2]),
    };
  }

  const cannotFind = text.match(/Cannot find (?:module|package) '([^']+)'(?: imported from ([^\s,]+))?/);
  if (cannotFind) {
    const specifier = cannotFind[1];
    const fromPath = cannotFind[2] ?? requireStackEntry(text);
    return {
      missingPackage: packageNameFromPath(specifier) ?? specifier,
      requiredFrom: fromPath ? (packageNameFromPath(fromPath) ?? fromPath) : null,
    };
  }

  return { missingPackage: null, requiredFrom: null };
}

/**
 * Pass/fail is on a resolution failure only. A route whose load dies on missing self-host config
 * fails too: it never reached its own requires, so a real external-ESM bug behind it would go
 * unseen. An unreported child (killed, OOM, an early process.exit) is also a failure: the route
 * was never probed. A route that never settles is likewise a failure, labelled with the timeout.
 * A clean load is `{}`; anything else (network, a side effect that throws) is a warning - it is
 * not the failure class this guards and must not fail every build that lacks a credential.
 */
export function classifyLoadResult({ code, message, timedOut, unreported } = {}) {
  // No report at all (killed, OOM, a route that exits the child) means the probe learned
  // nothing about the route. An unprobed route cannot be a silent pass.
  if (unreported) return FAIL;
  // A route that outran the timeout never finished loading; the per-route line says so.
  if (timedOut) return FAIL;
  const text = String(message ?? '');
  if (text.includes(SELF_HOST_CONFIG_MISSING)) return FAIL;
  if (findLoadFailureCode({ code, message })) return FAIL;
  if (code || message) return WARN;
  return PASS;
}

/** Groups warnings so a build with many non-resolution load errors prints a bounded summary. */
export function summarizeWarnings(results) {
  const counts = new Map();
  for (const { result } of results) {
    const key = result.code || String(result.message ?? '').split('\n')[0] || 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The last tagged report line the child wrote, or undefined if it wrote none. */
export function parseChildReport(stdout) {
  const index = String(stdout).lastIndexOf(REPORT_MARKER);
  if (index === -1) return undefined;
  const line = String(stdout).slice(index + REPORT_MARKER.length).split('\n')[0];
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function probeRoute(file, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-experimental-require-module', '-e', CHILD_SCRIPT, file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: undefined, message: String(error), timedOut, unreported: true });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const parsed = parseChildReport(stdout);
      if (parsed && typeof parsed === 'object') {
        resolve({ code: parsed.code, message: parsed.message, timedOut });
        return;
      }
      const fallback =
        [stderr.trim(), stdout.trim()].filter(Boolean).join('\n') ||
        `child exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`;
      resolve({ code: undefined, message: fallback, timedOut, unreported: true });
    });
  });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Copies the standalone root to a fresh temp dir and returns the `.next` path inside it. Node
 * resolves a route's externalized deps by walking ancestor node_modules, so probing in place
 * lets the builder's full install (which sits ABOVE the standalone root) satisfy a module the
 * trace omitted - the runner image does not carry that install. The copy has no such ancestors.
 */
export function isolateStandaloneTree(standaloneRoot, nextDirRel) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'api-route-probe-'));
  const isolatedRoot = path.join(tempRoot, 'standalone');
  // verbatimSymlinks keeps pnpm/Turbopack's relative links relative. Node's default copy
  // absolutizes them, so an external's realpath stays in the source tree and its own requires
  // walk the builder's ancestors again - the exact resolution this copy exists to prevent.
  fs.cpSync(standaloneRoot, isolatedRoot, { recursive: true, verbatimSymlinks: true });
  return {
    nextDir: path.join(isolatedRoot, nextDirRel),
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

async function main() {
  const [standaloneRoot, nextDirRel] = process.argv.slice(2);
  if (!standaloneRoot || !nextDirRel) {
    console.error(
      'usage: check-api-routes-cjs-require.mjs <standalone root> <.next dir relative to it> ' +
        '(e.g. apps/client/.next/standalone apps/client/.next)'
    );
    process.exit(1);
  }
  const sourceNextDir = path.resolve(standaloneRoot, nextDirRel);
  if (!fs.existsSync(sourceNextDir)) {
    console.error(`check-api-routes-cjs-require: no build output at ${sourceNextDir}`);
    process.exit(1);
  }

  const modules = listApiRouteModules(sourceNextDir);
  if (modules.length === 0) {
    // A guard that finds nothing to guard must not pass: a moved build root would otherwise
    // read as "all clear" and the load-failure class would go unchecked.
    console.error(
      `check-api-routes-cjs-require: no API route modules under ${path.join(sourceNextDir, 'server/pages/api')}`
    );
    process.exit(1);
  }

  const timeoutMs = Number(process.env.API_ROUTE_PROBE_TIMEOUT_MS) || 20_000;
  const { nextDir, cleanup } = isolateStandaloneTree(standaloneRoot, nextDirRel);
  let results;
  try {
    const concurrency = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
    results = await mapWithConcurrency(modules, concurrency, async (rel) => {
      const file = path.resolve(nextDir, rel);
      const result = await probeRoute(file, timeoutMs);
      return { rel, result, status: classifyLoadResult(result) };
    });
  } finally {
    cleanup();
  }

  const failures = results.filter((r) => r.status === FAIL);
  const warnings = results.filter((r) => r.status === WARN);

  if (warnings.length > 0) {
    console.warn(`check-api-routes-cjs-require: ${warnings.length} route(s) did not load cleanly but are not a resolution failure (not a failure):`);
    for (const [key, count] of summarizeWarnings(warnings)) {
      console.warn(`  ${count}x ${key}`);
    }
  }

  if (failures.length > 0) {
    console.error(`check-api-routes-cjs-require: ${failures.length} API route(s) cannot load at module load:`);
    for (const { rel, result } of failures) {
      const masked = String(result.message ?? '').includes(SELF_HOST_CONFIG_MISSING);
      const { missingPackage, requiredFrom } = describeLoadError(result.message);
      const named = [missingPackage && `module ${missingPackage}`, requiredFrom && `required from ${requiredFrom}`].filter(Boolean).join(', ');
      const timedOut = result.timedOut ? ` (timed out after ${timeoutMs}ms)` : '';
      const hint = masked ? ' [Self-host config missing - add the key to .env.selfhost.example]' : '';
      console.error(`  ${routePathForModule(rel)}${named ? ` (${named})` : ''}${timedOut}${hint}`);
    }
    console.error(
      'A module the bundler left external cannot be loaded from the built route, so production returns a framework HTML 500 before the handler runs. ' +
        'Pin or override the package to a dual-published version whose "exports" carries a require condition, add it to transpilePackages in apps/client/next.config.mjs so the bundler inlines it, ' +
        'or (for "Self-host config missing") add the key to .env.selfhost.example so the route is not masked.'
    );
  }

  console.log(`check-api-routes-cjs-require: ${results.length} routes probed, ${failures.length} failed to load`);
  process.exit(failures.length > 0 ? 1 : 0);
}

// Only run as a CLI; importing this module (the unit test does) must not spawn probes or exit.
// argv[1] is compared by realpath because `import.meta.url` is already realpath'd, and a
// symlinked invocation would otherwise exit 0 without probing anything.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
