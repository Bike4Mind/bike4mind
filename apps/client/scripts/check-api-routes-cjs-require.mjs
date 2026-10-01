#!/usr/bin/env node
// Fails the build when a BUILT API route cannot be require()d at module load.
//
// Failure class: an ESM-only package reached by a real require() from the CommonJS API-route
// bundle throws ERR_REQUIRE_ESM the moment the route module is loaded. Next has not started the
// handler and has not run auth middleware, so the caller gets a framework HTML 500 before any
// app code runs - and every unit test stays green, because vitest imports the source as ESM and
// never exercises a real require(). This probe loads the compiled route, so the bundler's
// bundled-vs-externalized decision is the thing under test.
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
// Why this probe lives in the Docker builder stage (Option C) rather than option A (a deployer
// post-build hook) or option B (a dedicated `next build` job in ci.yml): the self-host image
// workflow already runs a real `next build` on every PR that touches the app, and its builder
// stage already hosts the post-build guards (pruneTestRoutes.mjs, check-standalone-tree.mjs).
// Option A fires after the environment is live - an alarm, not a gate - and lives in another
// repo. Option B duplicates a build this workflow already pays for, at ~12GB of heap per PR,
// for no extra signal. Running here costs zero extra build minutes and probes the standalone
// tree, which is the closest PR-time artifact to what OpenNext traces into the Lambda.
//
// Usage: node apps/client/scripts/check-api-routes-cjs-require.mjs <.next/standalone/<app>/.next>
// Exit 1 on any ERR_REQUIRE_ESM, or when zero routes are found (the guard cannot pass silently).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FAIL = 'fail';
export const WARN = 'warn';
export const PASS = 'pass';

const ERR_REQUIRE_ESM = 'ERR_REQUIRE_ESM';

// A route module may itself write to stdout at load, so the child tags its report and the parent
// extracts the last tagged line rather than parsing the whole stream.
const REPORT_MARKER = '@@API_ROUTE_PROBE@@';

// Loader run in a child per route. require() is synchronous; the unhandledRejection handler and
// the short settle timer catch the case where Turbopack externalizes through an async import()
// that rejects after the module returns. The explicit exits keep a route's DB/SDK handles from
// holding the child open; the parent's timeout is the backstop for a route that never returns.
const CHILD_SCRIPT = `
const file = process.argv[1];
const write = (report) => {
  process.stdout.write(${JSON.stringify(REPORT_MARKER)} + JSON.stringify(report) + '\\n');
};
const report = (error) => {
  const code = error && error.code;
  const message = error && error.message ? String(error.message) : String(error);
  write({ loaded: false, code, message });
  process.exit(0);
};
process.on('unhandledRejection', (error) => report(error));
try {
  require(file);
} catch (error) {
  report(error);
}
setTimeout(() => {
  write({ loaded: true });
  process.exit(0);
}, 25);
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

/** The package a file path belongs to: the segment after the LAST node_modules (pnpm-aware), scoped-aware. */
export function packageNameFromPath(filePath) {
  const normalized = String(filePath).split(path.sep).join('/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const segments = normalized.slice(index + marker.length).split('/');
  if (!segments[0]) return null;
  if (segments[0].startsWith('@')) return segments.length >= 2 && segments[1] ? `${segments[0]}/${segments[1]}` : null;
  return segments[0];
}

/**
 * Names the ESM package and its requirer out of a Node ERR_REQUIRE_ESM message, e.g.
 * "require() of ES Module <esm> from <requirer> not supported." Best-effort: classification is by
 * error code, so a message shape change degrades the label, never the gate.
 */
export function describeEsmError(message) {
  const match = String(message ?? '').match(/require\(\) of ES Module (.*?) from (.*?) not supported\./);
  if (!match) return { esmPackage: null, requiredFrom: null };
  return { esmPackage: packageNameFromPath(match[1]), requiredFrom: packageNameFromPath(match[2]) };
}

/**
 * Pass/fail is on the error CODE only. A clean load is `{}`; any other load error (missing env,
 * network, a side effect that throws) is a warning - it is not the failure class this guards and
 * must not fail every build that lacks a credential.
 */
export function classifyLoadResult({ code, message, timedOut } = {}) {
  if (timedOut) return WARN;
  if (code === ERR_REQUIRE_ESM) return FAIL;
  if (code || message) return WARN;
  return PASS;
}

/** Groups warnings so a build with many non-ESM load errors prints a bounded summary. */
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
      resolve({ code: undefined, message: String(error), timedOut });
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
      resolve({ code: undefined, message: fallback, timedOut });
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

async function main() {
  const [nextDir] = process.argv.slice(2);
  if (!nextDir) {
    console.error('usage: check-api-routes-cjs-require.mjs <.next/standalone/<app>/.next dir>');
    process.exit(1);
  }
  if (!fs.existsSync(nextDir)) {
    console.error(`check-api-routes-cjs-require: no build output at ${nextDir}`);
    process.exit(1);
  }

  const modules = listApiRouteModules(nextDir);
  if (modules.length === 0) {
    // A guard that finds nothing to guard must not pass: a moved build root would otherwise
    // read as "all clear" and the ERR_REQUIRE_ESM class would go unchecked.
    console.error(`check-api-routes-cjs-require: no API route modules under ${path.join(nextDir, 'server/pages/api')}`);
    process.exit(1);
  }

  const timeoutMs = Number(process.env.API_ROUTE_PROBE_TIMEOUT_MS) || 20_000;
  const concurrency = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
  const results = await mapWithConcurrency(modules, concurrency, async (rel) => {
    const file = path.resolve(nextDir, rel);
    const result = await probeRoute(file, timeoutMs);
    return { rel, result, status: classifyLoadResult(result) };
  });

  const failures = results.filter((r) => r.status === FAIL);
  const warnings = results.filter((r) => r.status === WARN);

  if (warnings.length > 0) {
    console.warn(`check-api-routes-cjs-require: ${warnings.length} route(s) did not load cleanly but are not ERR_REQUIRE_ESM (not a failure):`);
    for (const [key, count] of summarizeWarnings(warnings)) {
      console.warn(`  ${count}x ${key}`);
    }
  }

  if (failures.length > 0) {
    console.error(`check-api-routes-cjs-require: ${failures.length} API route(s) throw ERR_REQUIRE_ESM at module load:`);
    for (const { rel, result } of failures) {
      const { esmPackage, requiredFrom } = describeEsmError(result.message);
      const named = [esmPackage && `package ${esmPackage}`, requiredFrom && `required from ${requiredFrom}`].filter(Boolean).join(', ');
      console.error(`  ${routePathForModule(rel)}${named ? ` (${named})` : ''}`);
    }
    console.error(
      'An ESM-only package reaches a real require() from the built route, so production returns a framework HTML 500 before the handler runs. ' +
        'Pin or override the package to a dual-published version whose "exports" carries a require condition, or add it to transpilePackages in apps/client/next.config.mjs so the bundler inlines it.'
    );
  }

  console.log(`check-api-routes-cjs-require: ${results.length} routes probed, ${failures.length} ERR_REQUIRE_ESM`);
  process.exit(failures.length > 0 ? 1 : 0);
}

// Only run as a CLI; importing this module (the unit test does) must not spawn probes or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
