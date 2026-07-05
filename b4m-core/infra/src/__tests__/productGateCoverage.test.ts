import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fail-closed gate coverage guard (Open Core M0).
 *
 * Every non-test route file under pages/api/overwatch/** and
 * pages/api/admin/overwatch/** must call `requestHasOverwatchAccess` (or wrap in
 * `withOverwatchProduct`, which calls it internally), and every non-test route
 * file under packages/premium/pi/src/api/** must call `requestHasPiAccess`. The gate must be an
 * actual CALL (`pattern(`) - comments and imports don't count (see stripComments).
 *
 * Routes in EXEMPTIONS are explicitly excluded with a justification -
 * the list is intentionally narrow. Any new exemption requires a comment.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Route files allowed to skip the product gate, with the reason. */
const EXEMPTIONS: Record<string, string> = {
  // v1/events is the external ingest endpoint: authenticated via OVERWATCH_INGEST_WRITE
  // API key scope only - no user session, no entitlement path. Stays core-owned (M1c).
  'apps/client/pages/api/overwatch/v1/events.ts': 'API-key-only ingest endpoint',
  // Admin-only operational data backfill (bulk-writes OverwatchUserFirstSeen). Not
  // user-facing product surface - an `overwatch:pro` holder must NOT be able to run
  // it, so it stays gated on `req.user.isAdmin`, strictly narrower than the product gate.
  'apps/client/pages/api/admin/overwatch/backfill-first-seen.ts': 'admin-only operational backfill',
};

function walkFiles(dir: string, ext = '.ts'): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkFiles(full, ext));
    } else if (entry.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function isTestFile(path: string): boolean {
  return path.includes('__tests__') || path.endsWith('.test.ts') || path.endsWith('.spec.ts');
}

/**
 * Strip `//` line comments and `/* *\/` block comments so a gate name that only
 * appears in a comment (or an import) can't satisfy the guard - the gate must be
 * an actual call. Not a full JS parser, but enough to defeat the trivial evasions.
 *
 * Known limitation: does NOT respect string/regex literals - a `//` inside a string
 * (e.g. an `https://` URL) is treated as a comment start. Fail-CLOSED: a mis-strip can
 * only drop a real gate call and cause a false CI failure, never let an ungated route
 * pass. Fine today because gate calls always sit on their own line, clear of URLs.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Gate patterns that constitute a valid access check for a product's routes.
 * A route must contain AT LEAST ONE of these strings to be considered gated.
 */
const OVERWATCH_GATE_PATTERNS = [
  'requestHasOverwatchAccess',
  // withOverwatchProduct internally calls requestHasOverwatchAccess (see
  // server/overwatch/utils/withOverwatchProduct.ts) - routes using this wrapper
  // are gated without calling the function directly.
  'withOverwatchProduct',
  // requestIsOverwatchAdmin is the WRITE gate (admin-only). Write-only route files
  // (key rotate/revoke, report publish) gate exclusively on this - no view gate.
  'requestIsOverwatchAdmin',
];

const PI_GATE_PATTERN = 'requestHasPiAccess';

/** Overwatch VIEW gates (reads). Excludes the admin-only WRITE gate on purpose. */
const OVERWATCH_VIEW_GATES = ['requestHasOverwatchAccess', 'withOverwatchProduct'];

/**
 * Overwatch routes that gate SOLELY on the admin write-gate (`requestIsOverwatchAdmin`)
 * with NO view gate - correct only because they expose no read/GET surface (single
 * write handler). Any OTHER overwatch route gated only on the write-gate is a mistake:
 * it would 403 legitimate VIEW users (developer / overwatch:pro). Enumerated explicitly
 * so a future read route can't silently regress to admin-only; adding a route here is a
 * deliberate act (like EXEMPTIONS).
 */
// M1c: route handlers live in packages/premium/overwatch/src/api/ (flat names).
const WRITE_ONLY_ADMIN_ROUTES = new Set([
  'packages/premium/overwatch/src/api/products-productId-keys-keyId-rotate.ts',
  'packages/premium/overwatch/src/api/products-productId-keys-keyId-revoke.ts',
  'packages/premium/overwatch/src/api/marketing-reports-id-publish.ts',
]);

function checkRoutes(apiDirs: string[], gatePatterns: string[]): { file: string; reason: string }[] {
  const failures: { file: string; reason: string }[] = [];
  const routeFiles = apiDirs.flatMap(dir => walkFiles(resolve(REPO_ROOT, dir))).filter(f => !isTestFile(f));

  for (const file of routeFiles) {
    const rel = relative(REPO_ROOT, file);
    if (EXEMPTIONS[rel]) continue;

    const source = stripComments(readFileSync(file, 'utf8'));
    // A gate counts only as an actual CALL (`pattern(`) - a bare mention, import,
    // or comment does not satisfy the guard.
    if (!gatePatterns.some(p => source.includes(`${p}(`))) {
      failures.push({
        file: rel,
        reason: `missing gate call (expected one of: ${gatePatterns.map(p => `${p}(`).join(', ')})`,
      });
    }
  }
  return failures;
}

describe('product gate coverage (fail-closed guard — Open Core M0)', () => {
  // M1c: overwatch API handlers live in packages/premium/overwatch/src/api/.
  // Core-owned routes (v1/events) and admin backfills stay in apps/client and are EXEMPTED.
  it('every overwatch API route is gated (requestHasOverwatchAccess or withOverwatchProduct)', () => {
    const failures = checkRoutes(
      [
        'packages/premium/overwatch/src/api',
        'apps/client/pages/api/overwatch',
        'apps/client/pages/api/admin/overwatch',
      ],
      OVERWATCH_GATE_PATTERNS
    );
    expect(failures).toEqual([]);
  });

  // Pi API handlers live in packages/premium/pi/src/api/ (flat dash-names) after
  // the Pi open-core carve; served at /api/premium-pi/* via codegen stubs.
  it('every Pi API route calls requestHasPiAccess', () => {
    const failures = checkRoutes(['packages/premium/pi/src/api'], [PI_GATE_PATTERN]);
    expect(failures).toEqual([]);
  });

  // Read/write split guard: the coverage check above accepts requestIsOverwatchAdmin
  // (the WRITE gate) as a valid gate, so a read route mistakenly gated only on it would
  // still pass coverage - while 403ing legitimate view users. This asserts that any
  // overwatch route gated solely on the write-gate is a known write-only route.
  it('no Overwatch route is gated solely on the admin write-gate unless it is write-only', () => {
    const files = [
      'packages/premium/overwatch/src/api',
      'apps/client/pages/api/overwatch',
      'apps/client/pages/api/admin/overwatch',
    ]
      .flatMap(dir => walkFiles(resolve(REPO_ROOT, dir)))
      .filter(f => !isTestFile(f));

    const failures: { file: string; reason: string }[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (EXEMPTIONS[rel]) continue;

      const source = stripComments(readFileSync(file, 'utf8'));
      const usesWriteGate = source.includes('requestIsOverwatchAdmin(');
      const hasViewGate = OVERWATCH_VIEW_GATES.some(p => source.includes(`${p}(`));

      if (usesWriteGate && !hasViewGate && !WRITE_ONLY_ADMIN_ROUTES.has(rel)) {
        failures.push({
          file: rel,
          reason:
            'gated only on requestIsOverwatchAdmin (write-gate) with no view gate — a read route ' +
            'would lock out view users (developer / overwatch:pro). If genuinely write-only, add to ' +
            'WRITE_ONLY_ADMIN_ROUTES; otherwise add a view gate (requestHasOverwatchAccess).',
        });
      }
    }
    expect(failures).toEqual([]);
  });
});
