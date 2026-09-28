// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { KNOWN_UNPOSTURED } from './apiKeyScopePostureLedger';

/**
 * `requiredScopes` is opt-in and defaults open: baseApi installs `apiKeyAuth(undefined)` for
 * every authed route that is not `auth: 'jwtOnly'`, so a route that simply says `baseApi()`
 * accepts any valid unconfined API key (decideScopeGate in apiKeyScopeGate.ts still denies a
 * confined key) of a user who can reach it. This scan makes that an explicit
 * choice for every new route. A route is "postured" when its source declares any of:
 *  - `requiredScopes:` / `alsoRequiredScopes:` (API keys must carry those scopes),
 *  - `auth: 'jwtOnly'` (the API-key chain is skipped, keys are rejected),
 *  - `auth: false` (no auth chain at all, so no API-key surface).
 *
 * pages/api/admin/** is excluded: adminApiKeyScopeCoverage.test.ts owns that tree with the
 * stricter exactly-`[ApiKeyScope.ADMIN]` check and its own ledger.
 *
 * KNOWN_UNPOSTURED (apiKeyScopePostureLedger.ts) is the ledger of routes that predate this
 * guard. It only shrinks; the stale-entry check forces removal once a route gains a posture.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and
// pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

// ponytail: file-level match - a file with several baseApi() calls counts as postured if any
// one of them (or any other object in the file) carries a marker. Per-call matching is the
// upgrade path if that ceiling ever hides a real gap. It also checks presence, not value, so a
// `requiredScopes: undefined` (or a conditional that can yield undefined) passes as postured.
const POSTURES = [/\b(requiredScopes|alsoRequiredScopes)\s*:/, /\bauth:\s*'jwtOnly'/, /\bauth:\s*false\b/];

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || (dir === ROUTES_DIR && entry.name === 'admin')) return [];
      return routeFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = routeFiles(ROUTES_DIR).filter(f => readFileSync(f, 'utf8').includes('baseApi('));
const rel = (f: string) => path.relative(ROUTES_DIR, f).split(path.sep).join('/');
// Strip line comments first so a commented-out `// requiredScopes: [...]` does not count.
const isPostured = (f: string) => {
  const src = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
  return POSTURES.some(re => re.test(src));
};

describe('baseApi routes declare an API-key scope posture', () => {
  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it.each(files.map(f => [rel(f), f]))('%s', (r, f) => {
    if (isPostured(f)) return;
    expect(
      KNOWN_UNPOSTURED.has(r),
      `route "${r}" declares no API-key scope posture, so any valid API key can call it. Either ` +
        `add baseApi({ requiredScopes: [ApiKeyScope.X] }), use auth: 'jwtOnly' if API keys must ` +
        `not reach it, or (with review) add "${r}" to KNOWN_UNPOSTURED in apiKeyScopePostureLedger.ts.`
    ).toBe(true);
  });

  it('has no stale KNOWN_UNPOSTURED entries (a listed route that got a posture or was removed)', () => {
    const present = new Set(files.map(rel));
    const stale = [...KNOWN_UNPOSTURED].filter(r => !present.has(r) || isPostured(path.join(ROUTES_DIR, r)));
    expect(stale, `these routes are now postured or deleted - delete them from KNOWN_UNPOSTURED`).toEqual([]);
  });

  it('keeps KNOWN_UNPOSTURED sorted and free of admin/ routes', () => {
    const entries = [...KNOWN_UNPOSTURED];
    expect(entries, 'KNOWN_UNPOSTURED must stay sorted').toEqual([...entries].sort());
    expect(
      entries.filter(r => r.startsWith('admin/')),
      'admin/ routes belong to adminApiKeyScopeCoverage'
    ).toEqual([]);
  });
});
