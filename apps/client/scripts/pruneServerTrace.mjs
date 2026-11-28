#!/usr/bin/env node
// Drops files the Next server never loads from the build's .nft.json traces, so the hosted
// server function stops shipping them.
//
// OpenNext's copyTracedFiles builds the Lambda from the `files` lists of `<.next>/**/*.nft.json`
// and copies nothing else, so a path removed here never reaches the deployment package. Unlike
// next.config.mjs's outputFileTracingExcludes, which Turbopack applies to every build's traces,
// this leaves the .next/standalone tree alone; the container build copies that tree as is.
//
// Every entry is a package the server reaches only through a lazy import() of a code path that
// never runs in this function, or a part of a package its entry point never reads. Removing a
// file that IS loaded fails at that import with MODULE_NOT_FOUND, not at boot, so each entry
// names what it relies on.
//
// Usage: node pruneServerTrace.mjs [--if-standalone] <path-to-.next-dir>
//   --if-standalone: no-op when <.next>/standalone is absent (a plain `next build`, which OpenNext
//   never packages), so the postbuild hook can run unconditionally.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The one isolated-vm prebuild the hosted server function loads: linux x86_64 (SST's default
 * server architecture; infra/web.ts sets none) on nodejs24.x (NODE_MODULE_VERSION 137), glibc
 * (AL2023). Must stay in sync with the `server` block in infra/web.ts;
 * packages/scripts/src/pruneServerTrace.test.ts fails when they drift.
 */
export const HOSTED_SERVER_RUNTIME = 'nodejs24.x';
export const HOSTED_SERVER_PREBUILD = 'linux-x64/isolated-vm.abi137.glibc.node';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const PRUNED_TRACE_PATTERNS = [
  // Browser automation runs only in a separate queue worker Lambda that installs its own copy
  // (infra/queues.ts). The server traces it because a shared module names it in a lazy import();
  // next's optional @playwright/test peer pulls in a second version. About 23 MB together.
  /\/node_modules\/(?:playwright|playwright-core|@playwright\/[^/]+)(?:\/|$)/,
  // tiktoken's node entry (tiktoken.cjs) reads only tiktoken_bg.wasm, which embeds every
  // encoding's ranks. lite/ is the `tiktoken/lite` entry point and encoders/ the rank files it is
  // fed; nothing here imports either. About 18 MB.
  /\/node_modules\/tiktoken\/(?:encoders|lite)(?:\/|$)/,
  // isolated-vm IS loaded here (the REPL sandbox routes), but node-gyp-build picks exactly one
  // prebuild for the running platform and ABI. next.config.mjs includes every linux glibc
  // prebuild because the self-host image (which copies the untouched standalone tree) may be
  // either arch; this function only ever loads the one matching HOSTED_SERVER_PREBUILD.
  // About 3.2 MB on a linux build. The optional hash suffix is Turbopack's alias for externals.
  new RegExp(`/node_modules/isolated-vm(?:-[0-9a-f]+)?/prebuilds/(?!${escapeRegExp(HOSTED_SERVER_PREBUILD)}$)`),
];

/** True when a traced path (relative to its .nft.json, any separator) must not ship. */
export function isPrunedTracePath(tracedPath) {
  const normalized = `/${tracedPath.split(path.sep).join('/')}`;
  return PRUNED_TRACE_PATTERNS.some(pattern => pattern.test(normalized));
}

// Skipped at the .next root only, so a route directory that happens to share one of these names
// is still pruned. The standalone tree is a copy Next already made; OpenNext reads its traces
// from the .next root, not from there.
const SKIPPED_ROOT_DIRS = new Set(['standalone', 'cache']);

function findTraceFiles(dir, isRoot = true) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(isRoot && SKIPPED_ROOT_DIRS.has(entry.name))) found.push(...findTraceFiles(full, false));
    } else if (entry.isFile() && entry.name.endsWith('.nft.json')) found.push(full);
  }
  return found;
}

/** Rewrites every trace under nextDir in place. Returns the number of traces and paths removed. */
export function pruneServerTrace(nextDir) {
  let traces = 0;
  let removed = 0;
  for (const traceFile of findTraceFiles(nextDir)) {
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    if (!Array.isArray(trace.files)) throw new Error(`${traceFile}: no "files" array`);
    const kept = trace.files.filter(file => !isPrunedTracePath(file));
    traces++;
    if (kept.length === trace.files.length) continue;
    removed += trace.files.length - kept.length;
    fs.writeFileSync(traceFile, JSON.stringify({ ...trace, files: kept }));
  }
  return { traces, removed };
}

// realpath: a symlinked invocation path would otherwise skip the CLI and prune nothing, silently.
const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (import.meta.url === pathToFileURL(invokedPath).href) {
  const args = process.argv.slice(2);
  const nextDir = args.find(arg => !arg.startsWith('--'));
  if (args.includes('--if-standalone') && nextDir && !fs.existsSync(path.join(nextDir, 'standalone'))) {
    console.log(`pruneServerTrace: no standalone output under ${nextDir}, nothing to prune`);
    process.exit(0);
  }
  if (!nextDir || !fs.existsSync(path.join(nextDir, 'server'))) {
    console.error('usage: pruneServerTrace.mjs [--if-standalone] <.next dir containing server/>');
    process.exit(1);
  }
  const { traces, removed } = pruneServerTrace(nextDir);
  // Zero traces means the layout moved and this silently stopped doing anything: fail instead.
  if (traces === 0) {
    console.error(`pruneServerTrace: no .nft.json traces under ${nextDir}`);
    process.exit(1);
  }
  console.log(`pruneServerTrace: removed ${removed} traced paths across ${traces} traces`);
}
