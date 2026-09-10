#!/usr/bin/env node
// Asserts the Next standalone app directory holds nothing but the entries a healthy build
// emits, so a file-tracing regression cannot quietly ship the source tree.
//
// A `next build --output standalone` for this app writes exactly five entries: the compiled
// .next, the generated help artifacts under app/, the traced node_modules, package.json and
// server.js. When the file tracer loses a concrete path it falls back to globbing the app
// directory, and everything it sweeps in lands here as raw source next to those five - which
// is how tens of MB of apps/client reached the Lambda and the container image at once.
//
// Allowlist rather than denylist on purpose: the next regression will sweep in a directory
// nobody thought to name. The allowlist is one level deeper under app/, because that name is
// the SPA source root and a sweep into it would otherwise land inside an allowed entry.
//
// Usage: node apps/client/scripts/check-standalone-tree.mjs <path-to-.next/standalone/<app>>

import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['.next', 'app', 'node_modules', 'package.json', 'server.js']);

// `app` cannot be allowlisted wholesale: in the source tree it is the SPA root, the largest
// directory in the package, so a sweep landing inside it would sit under an allowed entry and
// pass. Only one thing under it is read at runtime - server/help/retrieval.ts resolves
// app/generated/help-embeddings.json and help-index.json against cwd on each request - so the
// standalone copy is pinned a level deeper here rather than trusted as a unit.
const ALLOWED_UNDER_APP = new Set(['generated']);

const appDir = process.argv[2];
if (!appDir) {
  console.error('usage: check-standalone-tree.mjs <.next/standalone/<app> dir>');
  process.exit(1);
}
if (!fs.existsSync(appDir)) {
  console.error(`check-standalone-tree: no standalone app directory at ${appDir}`);
  process.exit(1);
}

const entries = fs.readdirSync(appDir).sort();
const entrySet = new Set(entries);
const offenders = entries.filter((entry) => !ALLOWED.has(entry));
const missing = [...ALLOWED].filter((entry) => !entrySet.has(entry)).sort();

// Reported with an `app/` prefix so the message names a path the reader can go and look at.
if (entrySet.has('app')) {
  for (const entry of fs.readdirSync(path.join(appDir, 'app')).sort()) {
    if (!ALLOWED_UNDER_APP.has(entry)) offenders.push(`app/${entry}`);
  }
}

if (offenders.length === 0 && missing.length === 0) {
  console.log(`check-standalone-tree: ${appDir} is clean (${entries.length} allowed entries)`);
  process.exit(0);
}

if (offenders.length > 0) {
  console.error(`check-standalone-tree: ${offenders.length} unexpected entries in ${appDir}`);
  for (const offender of offenders) {
    const full = path.join(appDir, offender);
    const kind = fs.lstatSync(full).isDirectory() ? 'dir ' : 'file';
    console.error(`  ${kind} ${offender}`);
  }
  console.error(
    'A failure here means file tracing swept the app source tree into the build output; expected only: ' +
      [...ALLOWED].join(', ') +
      ' (and under app/ only: ' +
      [...ALLOWED_UNDER_APP].join(', ') +
      ')'
  );
}

if (missing.length > 0) {
  // A truncated build (e.g. a build step that died silently) still writes a subset of the
  // allowed entries, which the offender check alone reports as clean.
  console.error(`check-standalone-tree: ${missing.length} expected entries missing from ${appDir}`);
  for (const entry of missing) {
    console.error(`  missing ${entry}`);
  }
}

process.exit(1);
