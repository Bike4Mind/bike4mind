import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Every test suite that boots a replica set must await `settleAutoIndexBuilds` before its first
 * transaction. Without it, the background `createIndexes` storm on connect can pin the connection
 * pool and a transaction opened meanwhile waits until mongod reaps it at 60s (see the doc comment on
 * `settleAutoIndexBuilds` in createMongoServer.ts). The failure needs a contended runner, so nothing
 * but a source pin catches a suite that drops or never had the settle.
 *
 * Checks presence, not placement: a settle that runs before the suite's model imports can still
 * settle nothing, which review has to catch. Comments are stripped first, so a commented-out settle
 * does not count.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCAN_ROOTS = ['apps', 'packages', 'b4m-core', 'selfhost'];
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.sst', '.turbo', 'coverage']);

// Any call, awaited or not. Type positions (`typeof createMongoReplSet`) have no parentheses after
// the name and import lines are removed before matching.
const REPLSET_CALL = /\bcreateMongoReplSet\s*\(/;
const SETTLE_CALL = /\bsettleAutoIndexBuilds\s*\(/;

function stripCommentsAndImports(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
}

// Billing-area suites are owned separately; remove an entry once its owner has settled it.
const ALLOWLIST = new Set([
  'apps/client/server/billing/grantCreditPurchase.e2e.test.ts',
  'packages/scripts/src/auditPartialCreditPurchases.integration.test.ts',
]);

function* walkTests(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkTests(path.join(dir, entry.name));
    } else if (/\.(test|spec)\.(ts|tsx|mts)$/.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

function replSetSuites(): Array<{ rel: string; source: string }> {
  const suites: Array<{ rel: string; source: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkTests(path.join(REPO_ROOT, root))) {
      if (file === SELF) continue;
      const source = stripCommentsAndImports(readFileSync(file, 'utf8'));
      if (REPLSET_CALL.test(source)) {
        suites.push({ rel: path.relative(REPO_ROOT, file).split(path.sep).join('/'), source });
      }
    }
  }
  return suites;
}

describe('replica-set suites settle index builds before their first transaction', () => {
  const suites = replSetSuites();

  it('finds the replica-set suites (the scan is not silently empty)', () => {
    expect(suites.length).toBeGreaterThan(10);
  });

  it('every createMongoReplSet() suite awaits settleAutoIndexBuilds', () => {
    const unsettled = suites.filter(s => !ALLOWLIST.has(s.rel) && !SETTLE_CALL.test(s.source)).map(s => s.rel);
    expect(unsettled).toEqual([]);
  });

  it('keeps the allowlist honest: every entry still exists and still lacks the settle', () => {
    const byRel = new Map(suites.map(s => [s.rel, s.source]));
    const stale = [...ALLOWLIST].filter(rel => !byRel.has(rel) || SETTLE_CALL.test(byRel.get(rel) ?? ''));
    expect(stale).toEqual([]);
  });
});
