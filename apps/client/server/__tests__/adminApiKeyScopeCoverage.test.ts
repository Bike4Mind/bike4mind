// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * `requiredScopes` is opt-in and defaults open (baseApi with no gate calls
 * `apiKeyAuth(undefined)`), so an admin route that forgets it is reachable by ANY
 * valid API key of an owner who can already reach it - the confinement the ADMIN gate
 * adds on top of the in-handler `isAdmin`/`ability.can` check. Nothing else fails when a
 * new admin route simply says `baseApi()`, so a source scan is the only guard that
 * survives someone adding the next admin route. Mirrors dataLakeApiKeyScopeCoverage.test.ts.
 *
 * Invariant: every admin route declares EXACTLY `[ApiKeyScope.ADMIN]`, unless it opts out of
 * API-key auth entirely via `auth: false` and is hand-listed in NO_API_KEY_AUTH. Each listed
 * entry must exist and still declare `auth: false`, so the list cannot go stale or hide a route.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and
// pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'admin');

// The gate every admin route should carry. Matches the declaration wherever it sits in the
// baseApi options (routes mix in `auth: true`, `rateLimit`, etc.), but pins the array to exactly
// `[ApiKeyScope.ADMIN]` so a route that swaps in a weaker/other scope is not accepted as "gated".
const ADMIN_GATE = /requiredScopes:\s*\[\s*ApiKeyScope\.ADMIN\s*\]/;

/**
 * `auth: false` means baseApi never installs the API-key chain (it installs
 * `apiKeyAuth(requiredScopes)` only when `auth` is truthy and not 'jwtOnly'), so a scope gate
 * here would be inert. These routes authenticate by shared-secret header or the emergency flow
 * instead. This list only shrinks; adding to it is a deliberate, reviewable edit.
 */
const NO_API_KEY_AUTH = new Set<string>([
  'emergency-login.ts',
  // Authorized by the run-scoped token in its path, minted only by the gated qa/runs/[id].ts.
  'qa/report/[runId]/[token]/[...path].ts',
  'rate-limits/ingest.ts',
  'security-dashboard/attack-simulation-ingest.ts',
  'security-dashboard/cloud-prowler-ingest.ts',
  'security-dashboard/code-semgrep-ingest.ts',
  'security-dashboard/packages-ingest.ts',
  'security-dashboard/secrets-ingest.ts',
  'security-dashboard/web-owasp-ingest.ts',
]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const files = routeFiles(ROUTES_DIR);
const rel = (f: string) => path.relative(ROUTES_DIR, f).split(path.sep).join('/');
// Strip line comments first so a commented-out gate (`// requiredScopes: [ApiKeyScope.ADMIN]`)
// does not read as gated. The declaration is often inline in the baseApi options, so the
// regex itself stays unanchored; removing comments is what prevents the false positive.
const source = (f: string) => readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
const isGated = (f: string) => ADMIN_GATE.test(source(f));
const declaresNoAuth = (f: string) => /\bauth:\s*false\b/.test(source(f));

describe('admin routes declare the ADMIN API-key scope gate', () => {
  it('finds the admin route files', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it.each(files.map(f => [rel(f), f]))('%s', (r, f) => {
    if (NO_API_KEY_AUTH.has(r)) return;
    expect(
      isGated(f),
      `admin route "${r}" has no requiredScopes gate. Add baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).`
    ).toBe(true);
  });

  it('every NO_API_KEY_AUTH entry exists and declares auth: false', () => {
    const present = new Set(files.map(rel));
    const invalid = [...NO_API_KEY_AUTH].filter(r => !present.has(r) || !declaresNoAuth(path.join(ROUTES_DIR, r)));
    expect(invalid, `these NO_API_KEY_AUTH entries are gone or no longer declare auth: false`).toEqual([]);
  });
});
