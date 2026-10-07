// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import {
  DATA_LAKE_READ_API_KEY_SCOPES,
  DATA_LAKE_WRITE_API_KEY_SCOPES,
  DATA_LAKE_QUERY_API_KEY_SCOPES,
  CONTRACTS,
  listDataLakesContract,
  getDataLakeContract,
  getDataLakeFileContract,
  addDataLakeFileContract,
  removeDataLakeFileContract,
  searchDataLakeContract,
} from '@bike4mind/common';
import { methodBlocks } from './scopeCoverageHelpers';

/**
 * `requiredScopes` is opt-in and defaults open, so a lake route that forgets it is
 * reachable by any valid API key of an owner who can already reach it - the gap this
 * family was closed to remove. A source scan is the only guard that survives someone
 * adding route number 44: nothing else fails when a new file simply says `baseApi()`.
 *
 * The second half is the read/write split. `baseApi`'s gate is per route, not per
 * method, so a route that serves a read AND a write declares the read gate and calls
 * `assertDataLakeWriteScope`/`assertDataLakeShareScope` inside the write handler.
 * Without this check, adding a `.post` to an existing read route would silently hand
 * every mutating door to a `datalake:read` key.
 *
 * The public `/api/v1/data-lakes/*` family covers the same doors through a contract
 * instead of `baseApi`, so it gets its own describe block below: it walks
 * `pages/api/v1/data-lakes` and pins each contract's `scopes` to the constant it must
 * carry.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route
// and pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'data-lakes');
const V1_ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'v1', 'data-lakes');
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/**
 * Routes whose POST is a read: they take a body because the query does not fit in a
 * URL, and they change nothing about the lake. Listed by hand because the method
 * cannot say so - which is the point of listing them: adding one is a deliberate
 * claim a reviewer can check, not a heuristic that quietly widens.
 */
const READ_ONLY_POST_ROUTES = new Set(['semantic-search.ts', 'rlm-answer.ts', 'compute-sync-delta.ts']);

/**
 * Routes with no published contract that API keys must never reach at all, so they need no scope
 * - listed by hand (not inferred from `auth: 'jwtOnly'`) so each exemption is a reviewed claim
 * rather than something a route silently opts into by omission.
 */
const JWT_ONLY_ROUTES = new Set(['[id]/membership-diff.ts']);

/**
 * Routes whose gate must be pinned to a SPECIFIC constant, not merely "some DATA_LAKE_ constant".
 * Without this, reverting a spend route's gate from DATA_LAKE_QUERY_SCOPES back to
 * DATA_LAKE_READ_SCOPES still passes every other check here - the generic regex below only cares
 * that a gate exists, not which one - so this round's read/query split would be one accidental
 * revert away from silently regressing.
 */
const EXPECTED_GATES: Record<string, string> = {
  'semantic-search.ts': 'DATA_LAKE_QUERY_SCOPES',
  'rlm-answer.ts': 'DATA_LAKE_QUERY_SCOPES',
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const files = routeFiles(ROUTES_DIR);
const v1Files = routeFiles(V1_ROUTES_DIR);

/**
 * The six contracts CONTRACTS carries for this family, keyed to the constant each one's
 * `scopes` must be pinned to. `search` is pinned to the query-only set specifically at a
 * reviewer's request: it spends an embedding call and must not open to a `datalake:read`-only key.
 */
const V1_EXPECTED_SCOPES = [
  [listDataLakesContract, DATA_LAKE_READ_API_KEY_SCOPES] as const,
  [getDataLakeContract, DATA_LAKE_READ_API_KEY_SCOPES] as const,
  [getDataLakeFileContract, DATA_LAKE_READ_API_KEY_SCOPES] as const,
  [addDataLakeFileContract, DATA_LAKE_WRITE_API_KEY_SCOPES] as const,
  [removeDataLakeFileContract, DATA_LAKE_WRITE_API_KEY_SCOPES] as const,
  [searchDataLakeContract, DATA_LAKE_QUERY_API_KEY_SCOPES] as const,
];

// Keyed by the identifier a route passes to nextRouteForContract(), so the source scan can tie
// each v1 router to a pinned contract rather than one built inline and never registered.
const V1_CONTRACTS_BY_IDENTIFIER = {
  listDataLakesContract,
  getDataLakeContract,
  getDataLakeFileContract,
  addDataLakeFileContract,
  removeDataLakeFileContract,
  searchDataLakeContract,
};

describe('data-lake routes declare an API-key scope gate', () => {
  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files.map(f => [path.relative(ROUTES_DIR, f), f]))('%s', (rel, file) => {
    const source = readFileSync(file, 'utf8');

    // jwt-only routes are unreachable by API keys, so they need no scope; this per-file
    // test IS the sanity check - if the route loses `auth: 'jwtOnly'` this case fails.
    if (JWT_ONLY_ROUTES.has(rel)) {
      expect(source, `${rel} must stay declared as baseApi({ auth: 'jwtOnly' })`).toContain(
        "baseApi({ auth: 'jwtOnly' })"
      );
      expect(source).not.toContain('requiredScopes');
      expect(source).not.toContain('ApiKeyScope.ADMIN');
      return;
    }

    const gate = source.match(/baseApi\(\{ requiredScopes: (DATA_LAKE_[A-Z_]+) \}\)/);
    expect(gate, 'route must declare requiredScopes from @server/dataLakes/dataLakeScopes').not.toBeNull();

    // See dataLakeScopes.ts: admin:* is unstageable, and one mention would deny this
    // family its staging grace period.
    expect(source).not.toContain('ApiKeyScope.ADMIN');

    const expectedGate = EXPECTED_GATES[rel];
    if (expectedGate) {
      expect(gate![1], `${rel} must stay pinned to ${expectedGate}`).toBe(expectedGate);
    }

    if (READ_ONLY_POST_ROUTES.has(rel)) return;

    // DATA_LAKE_QUERY_SCOPES is listed here too (not just inferred via READ_ONLY_POST_ROUTES) so
    // the two lists don't silently rely on each other to cover the query routes.
    const gatesWritesAtTheDoor =
      gate![1] === 'DATA_LAKE_WRITE_SCOPES' ||
      gate![1] === 'DATA_LAKE_SHARE_SCOPES' ||
      gate![1] === 'DATA_LAKE_QUERY_SCOPES';
    if (gatesWritesAtTheDoor) return;

    for (const { method, body } of methodBlocks(source)) {
      if (!MUTATING_METHODS.has(method)) continue;
      expect(body, `.${method} on a read-gated route must assert the stronger scope in-handler`).toMatch(
        /assertDataLake(Write|Share)Scope\(req\)/
      );
    }
  });
});

describe('public /api/v1/data-lakes routes gate scopes through their contract', () => {
  it('finds the v1 route files', () => {
    expect(v1Files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(v1Files.map(f => [path.relative(V1_ROUTES_DIR, f), f]))('%s', (rel, file) => {
    const source = readFileSync(file, 'utf8');

    // These routes gate through the contract's `scopes`, not `baseApi({ requiredScopes })` -
    // a stray baseApi call would mean an ungated door alongside (or instead of) the contract one.
    expect(source, `${rel} must not call baseApi(...)`).not.toContain('baseApi(');
    expect(source, `${rel} must build every method router with nextRouteForContract(...)`).toContain(
      'nextRouteForContract('
    );
    expect(source).not.toContain('ApiKeyScope.ADMIN');
  });

  it('builds every v1 router from a pinned contract, and gives every pinned contract a router', () => {
    const routed = v1Files.flatMap(f =>
      [...readFileSync(f, 'utf8').matchAll(/nextRouteForContract\(\s*(\w+)/g)].map(m => m[1])
    );
    expect(new Set(routed)).toEqual(new Set(Object.keys(V1_CONTRACTS_BY_IDENTIFIER)));
    expect(Object.values(V1_CONTRACTS_BY_IDENTIFIER)).toEqual(V1_EXPECTED_SCOPES.map(([c]) => c));
  });

  it('lists exactly these six contracts under /api/v1/data-lakes', () => {
    const v1Contracts = CONTRACTS.filter(c => c.path.startsWith('/api/v1/data-lakes'));
    expect(v1Contracts).toEqual(expect.arrayContaining(V1_EXPECTED_SCOPES.map(([c]) => c)));
    expect(v1Contracts).toHaveLength(V1_EXPECTED_SCOPES.length);
  });

  it.each(V1_EXPECTED_SCOPES.map(([c, scopes]) => [c.operationId, c, scopes] as const))(
    '%s is pinned to its expected scope set',
    (_operationId, c, expectedScopes) => {
      expect(c.scopes).toBe(expectedScopes);
    }
  );
});

describe('methodBlocks splitter', () => {
  it('recognizes a chained opener with a generic type argument', () => {
    const blocks = methodBlocks(
      'baseApi().post<Foo>(asyncHandler(async (req, res) => { assertDataLakeWriteScope(req); }))'
    );
    expect(blocks.map(b => b.method)).toEqual(['post']);
  });

  it('does not mistake a local Map.get() call for a route method', () => {
    const source = [
      'const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })',
      '  .post(async (req, res) => {',
      '    const x = userById.get(id);',
      '    assertDataLakeWriteScope(req);',
      '  });',
    ].join('\n');
    const blocks = methodBlocks(source);
    expect(blocks.map(b => b.method)).toEqual(['post']);
    expect(blocks[0].body).toContain('assertDataLakeWriteScope(req)');
  });

  it('splits a route with both a .get and a .post into separate blocks', () => {
    const source = 'baseApi().get(async () => {}).post(async () => { assertDataLakeWriteScope(req); })';
    const blocks = methodBlocks(source);
    expect(blocks.map(b => b.method)).toEqual(['get', 'post']);
    expect(blocks[1].body).toContain('assertDataLakeWriteScope');
  });
});
