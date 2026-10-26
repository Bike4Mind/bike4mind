// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { ADMIN_GATE, ADMIN_OR_RELEASE_NOTES_WRITE_GATE } from './scopeCoverageHelpers';

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
 * A route declaring `auth: 'jwtOnly'` is exempt without a list: no key can reach it, so there is
 * nothing to confine, and check-contract-gate.sh requires it of every new route outside /api/v1.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and
// pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'admin');

/**
 * `auth: false` means baseApi never installs the API-key chain (it installs
 * `apiKeyAuth(requiredScopes)` only when `auth` is truthy and not 'jwtOnly'), so a scope gate
 * here would be inert. These routes authenticate by shared-secret header, the emergency flow, or
 * a run-scoped token in the path instead. This list only shrinks; adding to it is a deliberate, reviewable edit.
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

/**
 * The admin routes that also admit a `release-notes:write` key: the release-video job reads a note
 * by tag and sets its video. That scope is confined (CONFINED_API_KEY_SCOPES), so this list is the
 * whole of its admin reach; config.ts and [id]/status.ts stay ADMIN-only on purpose.
 */
const ADMIN_OR_RELEASE_NOTES_WRITE = new Set<string>(['release-notes/[id].ts', 'release-notes/index.ts']);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const files = routeFiles(ROUTES_DIR);
const rel = (f: string) => path.relative(ROUTES_DIR, f).split(path.sep).join('/');
// Strip comments and string literals first so a gate that only appears in one (`/* requiredScopes:
// [ApiKeyScope.ADMIN] */`, `'requiredScopes: [...]'`) does not read as gated. The declaration is
// often inline in the baseApi options, so the regex itself stays unanchored; stripping is what
// prevents the false positive. A `//` inside a string can only over-strip, failing closed.
const withoutComments = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
const source = (f: string) => withoutComments(f).replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
const isGated = (f: string) => ADMIN_GATE.test(source(f));
const isReleaseNotesGated = (f: string) => ADMIN_OR_RELEASE_NOTES_WRITE_GATE.test(source(f));
const declaresNoAuth = (f: string) => /\bauth:\s*false\b/.test(source(f));
// Read with strings intact (the value is itself a literal), so only comments can fake it.
const JWT_ONLY = /\bauth:\s*['"]jwtOnly['"]/;
const declaresJwtOnly = (f: string) => JWT_ONLY.test(withoutComments(f));

describe('admin routes declare the ADMIN API-key scope gate', () => {
  it('ADMIN_GATE accepts only an exactly-[ApiKeyScope.ADMIN] array, in any layout', () => {
    expect(ADMIN_GATE.test('requiredScopes: [ApiKeyScope.ADMIN]')).toBe(true);
    expect(ADMIN_GATE.test('requiredScopes: [\n    ApiKeyScope.ADMIN\n  ]')).toBe(true);
    expect(ADMIN_GATE.test('requiredScopes: [\n    ApiKeyScope.ADMIN,\n  ]')).toBe(true);
    expect(ADMIN_GATE.test('requiredScopes: [ApiKeyScope.ADMIN, ApiKeyScope.FILES_READ]')).toBe(false);
    expect(ADMIN_GATE.test('requiredScopes: [ApiKeyScope.FILES_READ]')).toBe(false);
  });

  it("JWT_ONLY matches only an auth: 'jwtOnly' option", () => {
    expect(JWT_ONLY.test("baseApi({ auth: 'jwtOnly' })")).toBe(true);
    expect(JWT_ONLY.test('baseApi({ auth: "jwtOnly", maxBodySize: 1 })')).toBe(true);
    expect(JWT_ONLY.test('baseApi({ auth: true })')).toBe(false);
    expect(JWT_ONLY.test("baseApi({ auth: 'jwt' })")).toBe(false);
  });

  it('finds the admin route files', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it('ADMIN_OR_RELEASE_NOTES_WRITE_GATE accepts only exactly ADMIN plus RELEASE_NOTES_WRITE', () => {
    const gate = ADMIN_OR_RELEASE_NOTES_WRITE_GATE;
    expect(gate.test('requiredScopes: [ApiKeyScope.ADMIN, ApiKeyScope.RELEASE_NOTES_WRITE]')).toBe(true);
    expect(gate.test('requiredScopes: [\n    ApiKeyScope.ADMIN,\n    ApiKeyScope.RELEASE_NOTES_WRITE,\n  ]')).toBe(
      true
    );
    expect(gate.test('requiredScopes: [ApiKeyScope.ADMIN]')).toBe(false);
    expect(gate.test('requiredScopes: [ApiKeyScope.RELEASE_NOTES_WRITE]')).toBe(false);
    expect(
      gate.test('requiredScopes: [ApiKeyScope.ADMIN, ApiKeyScope.RELEASE_NOTES_WRITE, ApiKeyScope.READ_FILES]')
    ).toBe(false);
  });

  it.each(files.map(f => [rel(f), f]))('%s', (r, f) => {
    if (NO_API_KEY_AUTH.has(r) || declaresJwtOnly(f)) return;
    if (ADMIN_OR_RELEASE_NOTES_WRITE.has(r)) {
      expect(
        isReleaseNotesGated(f),
        `admin route "${r}" must declare [ApiKeyScope.ADMIN, ApiKeyScope.RELEASE_NOTES_WRITE]`
      ).toBe(true);
      return;
    }
    expect(
      isGated(f),
      `admin route "${r}" has no requiredScopes gate. Add baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).`
    ).toBe(true);
  });

  it('every ADMIN_OR_RELEASE_NOTES_WRITE entry exists', () => {
    const present = new Set(files.map(rel));
    expect([...ADMIN_OR_RELEASE_NOTES_WRITE].filter(r => !present.has(r))).toEqual([]);
  });

  it('every NO_API_KEY_AUTH entry exists and declares auth: false', () => {
    const present = new Set(files.map(rel));
    const invalid = [...NO_API_KEY_AUTH].filter(r => !present.has(r) || !declaresNoAuth(path.join(ROUTES_DIR, r)));
    expect(invalid, `these NO_API_KEY_AUTH entries are gone or no longer declare auth: false`).toEqual([]);
  });
});
