// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

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
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route
// and pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'data-lakes');
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/**
 * Routes whose POST is a read: they take a body because the query does not fit in a
 * URL, and they change nothing about the lake. Listed by hand because the method
 * cannot say so - which is the point of listing them: adding one is a deliberate
 * claim a reviewer can check, not a heuristic that quietly widens.
 */
const READ_ONLY_POST_ROUTES = new Set(['semantic-search.ts', 'rlm-answer.ts', 'compute-sync-delta.ts']);

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

/**
 * Splits a handler chain into [method, body] pairs - body runs to the next `.method(` or EOF.
 * Not anchored to a leading newline: a handler chained onto the `baseApi(...)` line itself (e.g.
 * `baseApi().post(...)`, as in articles.ts and tag-counts.ts) would otherwise produce no block and
 * never get scanned. Tolerates a generic type argument (`.post<T>(`), used by other route files
 * under `pages/api` - not live on a data-lake route today, but a future one using that syntax
 * would otherwise pass this guard with an unasserted mutating handler.
 *
 * The opener is filtered to matches whose preceding character is NOT an identifier character:
 * a fluent `baseApi(...).use(...).post(` chain always follows a `)` (or whitespace), while
 * `someMap.get(x)` follows an identifier - so an unrelated `.get(`/`.post(` call inside a handler
 * body (e.g. `userById.get(id)`) is not mistaken for another route method and does not truncate
 * the body it lives in.
 */
function methodBlocks(source: string): Array<{ method: string; body: string }> {
  const opener = /\.(get|post|put|patch|delete)(?:<[^<>]*>)?\(/g;
  const starts: Array<{ method: string; index: number }> = [];
  for (const match of source.matchAll(opener)) {
    const precedingChar = source[match.index! - 1];
    if (precedingChar && /[A-Za-z0-9_$]/.test(precedingChar)) continue;
    starts.push({ method: match[1], index: match.index! });
  }
  return starts.map(({ method, index }, i) => ({
    method,
    body: source.slice(index, starts[i + 1]?.index ?? source.length),
  }));
}

const files = routeFiles(ROUTES_DIR);

describe('data-lake routes declare an API-key scope gate', () => {
  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files.map(f => [path.relative(ROUTES_DIR, f), f]))('%s', (rel, file) => {
    const source = readFileSync(file, 'utf8');

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
