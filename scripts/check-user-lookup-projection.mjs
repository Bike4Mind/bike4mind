#!/usr/bin/env node
// Fails if a `$lookup` from the `users` collection has no inner `$project`, or if a
// `{ password: 0 }` exclusion projection is used. An aggregation `$lookup` ignores
// Mongoose `select:false`, so a lookup without an inner projection pulls in the FULL
// user document, including fields that should never reach a client. Requiring an
// inner `$project` keeps the join safe by construction rather than relying on a
// later stage to drop those fields.
//
// Run in CI on every PR (deploy.yml) and locally via husky pre-commit.
//
// To add a legitimate exception (e.g. the full doc is provably dropped downstream and
// the endpoint is tightly scoped): add the file path to
// scripts/user-lookup-projection-allowlist.txt with a comment explaining why.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['apps/client/pages', 'apps/client/server', 'b4m-core', 'packages'];
const ALLOWLIST_FILE = 'scripts/user-lookup-projection-allowlist.txt';
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '__test__']);

const allow = new Set(
  readFileSync(ALLOWLIST_FILE, 'utf8')
    .split('\n')
    .map(l => l.replace(/#.*/, '').trim())
    .filter(Boolean)
);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

// Return the {...} block (inclusive) whose opening brace is at/after openBraceIdx.
function extractBlock(text, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openBraceIdx, i + 1);
    }
  }
  return text.slice(openBraceIdx);
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

const violations = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (allow.has(file)) continue;
    const text = readFileSync(file, 'utf8');

    if (/password\s*:\s*0\b/.test(text)) {
      violations.push(`${file}: has a { password: 0 } exclusion projection -- use an inclusion allowlist instead`);
    }

    const re = /\$lookup\s*:\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      const braceIdx = m.index + m[0].length - 1;
      const block = extractBlock(text, braceIdx);
      if (!/from\s*:\s*['"]users['"]/.test(block)) continue;
      if (/\$project/.test(block)) continue; // has an inner projection -> safe by construction
      violations.push(`${file}:${lineOf(text, m.index)}: $lookup from 'users' has no inner $project (attaches the full user doc)`);
    }
  }
}

if (violations.length) {
  console.error("❌ Unprojected user $lookup(s) / exclusion projection(s) found:\n");
  for (const v of violations) console.error('  ' + v);
  console.error('\nFix: add an inner $project to the $lookup sub-pipeline (reuse SAFE_USER_LOOKUP_PROJECT');
  console.error('from @bike4mind/common, spreading it and adding only the extra non-secret fields needed),');
  console.error(`or add the file to ${ALLOWLIST_FILE} with a comment explaining why it is safe.`);
  process.exit(1);
}
console.log('✅ All user $lookups project safe fields (or are allowlisted).');
