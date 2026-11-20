import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Wiring drift guard for contributed navigation views.
 *
 * Registration is a side effect of importing server-utils' navigation/registerContributedViews, and a
 * process that skips the import sees only the static views: the navigate_view guidance and tool then
 * silently omit every contributed page. Both are built inside ChatCompletionProcess, so this walks the
 * same call sites as premiumToolsWiring.repo.test.ts and asserts each file imports the registration or
 * is allowlisted with a reason. Workers files are read from disk, never imported, so the one-way
 * client -> workers import rule still holds.
 */

const CLIENT_ROOT = join(__dirname, '..');
const REPO_ROOT = join(CLIENT_ROOT, '../..');

// The package specifier from the apps, a relative one inside packages/server-utils.
const REGISTRATION_IMPORT =
  /^import '(?:@bike4mind\/server-utils\/|(?:\.\.?\/)+)navigation\/registerContributedViews';$/m;

/** Files allowed to construct ChatCompletionProcess without the registration. */
const INTENTIONAL_OMISSIONS = new Set<string>([
  // Admin harness with a hardcoded tool list and no view context, so navigate_view is never offered.
  'pages/api/admin/rapid-reply/test.ts',
]);

// Relative to CLIENT_ROOT; code moved into apps/workers or packages/server-utils keeps its call sites.
const SCAN_DIRS = ['pages', 'server', 'app', '../workers/src', '../../packages/server-utils/src'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.sst', '__tests__', 'premium-generated']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe('contributed navigation views wiring', () => {
  const callSites = SCAN_DIRS.flatMap(d => walk(join(CLIENT_ROOT, d)))
    .filter(f => readFileSync(f, 'utf8').includes('new ChatCompletionProcess('))
    .map(f => relative(CLIENT_ROOT, f));

  it('finds the known ChatCompletionProcess call sites (sanity)', () => {
    // If this drops to zero the scan itself broke (renamed class, moved dirs).
    expect(callSites.length).toBeGreaterThanOrEqual(5);
  });

  it.each(callSites)('%s imports the view registration or is allowlisted', file => {
    const imported = REGISTRATION_IMPORT.test(readFileSync(join(CLIENT_ROOT, file), 'utf8'));
    expect(
      imported || INTENTIONAL_OMISSIONS.has(file),
      `${file} constructs ChatCompletionProcess but neither imports navigation/registerContributedViews nor is allowlisted in INTENTIONAL_OMISSIONS`
    ).toBe(true);
  });

  it('keeps the allowlist free of stale entries', () => {
    for (const entry of INTENTIONAL_OMISSIONS) {
      expect(callSites, `allowlist entry ${entry} no longer constructs ChatCompletionProcess`).toContain(entry);
    }
  });

  it('points the imports at the registration module that exists', () => {
    expect(existsSync(join(REPO_ROOT, 'packages/server-utils/src/navigation/registerContributedViews.ts'))).toBe(true);
  });
});
