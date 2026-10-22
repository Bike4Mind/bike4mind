// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Invariant: an API key cannot obtain a session token.
 *
 * A route that mints session credentials (a session, an access token, a refresh family, an OAuth
 * authorization code) or writes the device-authorization store (whose approval the device later
 * redeems for a session) must be unreachable with an API key. Otherwise a narrowly scoped key could
 * trade itself for a session that ignores the key's scopes, expiry and revocation. Every baseApi()
 * call in such a route must therefore be either:
 *  - `auth: 'jwtOnly'`: the api-key chain is never installed, so a key is not a credential there;
 *  - `auth: false`: the route authenticates by what it redeems (a code, a refresh token, a cookie),
 *    never by the caller's identity, so a key presented to it authenticates nothing.
 * A hand-mounted `apiKeyAuth(...)` or `optionalAuth` re-opens the key surface and fails either way.
 *
 * Routes are found by call site, so a new minting route is held to this without anyone listing it.
 * The minting helpers are only defined under server/auth and are called directly from routes, so
 * scanning pages/api (admin/ included) reaches every path. Sibling guard for scope posture in
 * general: apiKeyScopePostureCoverage.test.ts.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and
// pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

const SESSION_GRANT_MARKERS = [
  /\bissueSessionForRequest\(/,
  /\.issueSession\(/,
  /\.signAccessToken\(/,
  /\bgenerateAuthCode\(/,
  /\bmintRefreshFamily\(/,
  /\bdeviceAuthorizationRepository\b/,
  /\bDeviceAuthorizationModel\b/,
];
const KEY_CLOSED_AUTH = /\bauth:\s*(?:'jwtOnly'|false\b)/;
const KEY_SHIMS = [/\bapiKeyAuth\(/, /\boptionalAuth\b/];
// Object-literal options only; a route passing a variable (`baseApi(opts)`) fails closed below.
const BASE_API_CALL = /\bbaseApi\(([^)]*)\)/g;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Drops comment-only lines, JSDoc blocks and trailing comments so a mention in prose is not a call
// site. Anchored on whitespace so a `//` inside a URL string survives.
const stripComments = (src: string) =>
  src
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/[^\n]*/gm, '')
    .replace(/\s\/\/[^\n]*/g, '');

const rel = (f: string) => path.relative(ROUTES_DIR, f).split(path.sep).join('/');

const sessionGrantRoutes = routeFiles(ROUTES_DIR)
  .map(f => ({ route: rel(f), src: stripComments(readFileSync(f, 'utf8')) }))
  .filter(({ src }) => SESSION_GRANT_MARKERS.some(re => re.test(src)));

function keyOpenings(src: string): string[] {
  const calls = [...src.matchAll(BASE_API_CALL)].map(m => m[0]);
  if (calls.length === 0) return ['no baseApi() call to check (wrapped or non-baseApi route)'];
  const openCalls = calls.filter(call => !KEY_CLOSED_AUTH.test(call));
  const shims = KEY_SHIMS.filter(re => re.test(src)).map(re => `mounts ${re.source}`);
  return [...openCalls, ...shims];
}

describe('an API key cannot obtain a session token', () => {
  it('finds the known session-granting routes', () => {
    const found = sessionGrantRoutes.map(r => r.route);
    expect(found).toEqual(
      expect.arrayContaining([
        'oauth/code.ts',
        'oauth/device/verify.ts',
        'oauth/device/token.ts',
        'oauth/token.ts',
        'users/[id]/loginAs.ts',
      ])
    );
  });

  it.each(sessionGrantRoutes.map(r => [r.route, r.src]))('%s rejects API keys', (route, src) => {
    expect(
      keyOpenings(src),
      `${route} grants a session but an API key can reach it. Use baseApi({ auth: 'jwtOnly' }), or ` +
        `auth: false when the route authenticates only by what it redeems.`
    ).toEqual([]);
  });
});
