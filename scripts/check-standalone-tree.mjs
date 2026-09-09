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
// nobody thought to name.
//
// Usage: node scripts/check-standalone-tree.mjs <path-to-.next/standalone/<app>>

import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['.next', 'app', 'node_modules', 'package.json', 'server.js']);

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
const offenders = entries.filter((entry) => !ALLOWED.has(entry));

if (offenders.length === 0) {
  console.log(`check-standalone-tree: ${appDir} is clean (${entries.length} allowed entries)`);
  process.exit(0);
}

console.error(`check-standalone-tree: ${offenders.length} unexpected entries in ${appDir}`);
for (const offender of offenders) {
  const full = path.join(appDir, offender);
  const kind = fs.lstatSync(full).isDirectory() ? 'dir ' : 'file';
  console.error(`  ${kind} ${offender}`);
}
console.error(
  'A failure here means file tracing swept the app source tree into the build output; expected only: ' +
    [...ALLOWED].join(', ')
);
process.exit(1);
