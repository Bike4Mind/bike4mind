#!/usr/bin/env node
// Fails if a tracked sst-env.d.ts declares a secret that infra/*.ts does not.
//
// `sst install` / `sst dev` regenerate every sst-env.d.ts from what the stage links, so a run
// with a package mounted under packages/premium/ writes the secrets it contributes into these
// TRACKED files, publishing their names. They must always be generated without overlays.
// Runs in CI on every PR (lockfile-integrity.yml) and in husky pre-commit (--staged, which
// checks the staged copies only when one is staged).
//
// Usage: node scripts/check-sst-env-core-secrets.mjs [--staged]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const staged = process.argv.includes('--staged');
const git = args => execFileSync('git', args, { encoding: 'utf8' });

// Core secrets infra/ no longer declares that the committed file still lists until it is
// next regenerated. Remove an entry once the file drops it.
const RETIRED_CORE_SECRETS = ['PDFJS_EXPRESS_VIEWER_KEY'];

// Consume comments and string/template literals as whole tokens, so constructor-shaped
// examples in prose or a string cannot authorize a secret declaration.
const secretDeclarationTokens =
  /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|new\s+sst\.Secret\s*\(\s*'([A-Za-z0-9_]+)'/g;
const coreSecrets = new Set(RETIRED_CORE_SECRETS);
const coreFiles = staged
  ? git(['ls-files', '--cached', '--', 'infra'])
      .split('\n')
      .filter(file => /^infra\/[^/]+\.ts$/.test(file))
  : readdirSync('infra')
      .filter(file => file.endsWith('.ts'))
      .map(file => join('infra', file));
for (const file of coreFiles) {
  // Both inventories must describe the same snapshot: an unstaged constructor must
  // never authorize a secret name that the pending commit would otherwise leak.
  const source = staged ? git(['show', `:${file}`]) : readFileSync(file, 'utf8');
  for (const match of source.matchAll(secretDeclarationTokens)) {
    if (match[1]) coreSecrets.add(match[1]);
  }
}

const files = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=AM'] : ['ls-files'])
  .split('\n')
  .filter(f => f === 'sst-env.d.ts' || f.endsWith('/sst-env.d.ts'));

const leaks = [];
for (const file of files) {
  const content = staged ? git(['show', `:${file}`]) : readFileSync(file, 'utf8');
  for (const m of content.matchAll(/"([^"]+)":\s*\{\s*"type":\s*"sst\.sst\.Secret"/g)) {
    if (!coreSecrets.has(m[1])) leaks.push(`${file}: ${m[1]}`);
  }
}

if (leaks.length > 0) {
  console.error('ERROR: sst-env.d.ts declares secrets that infra/ does not:');
  for (const leak of leaks.slice(0, 20)) console.error(`  ${leak}`);
  console.error('\nThese files must be generated with packages/premium/ empty. Restore them with');
  console.error('`git checkout -- "*sst-env.d.ts"`, or regenerate without overlays (`pnpm sst install`).');
  process.exit(1);
}

console.log(`OK: sst-env.d.ts declares only core secrets (${files.length} file(s) checked).`);
