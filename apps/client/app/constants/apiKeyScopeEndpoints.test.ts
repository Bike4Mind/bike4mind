// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ApiKeyScope, CONTRACTS } from '@bike4mind/common';
import * as dataLakeScopes from '@server/dataLakes/dataLakeScopes';
import {
  CLIENT_DIR,
  HAND_HELPERS,
  HELPERS,
  OFF_PAGES_ROUTES,
  PAGES_DIR,
  SCOPE_MODULES,
  doorsIn,
  gatesForRoute,
  gatesIn,
  isOverlayPath,
  normalizePath,
  parseEndpoint,
  resolvePageFile,
  scopeOf,
  servesVerb,
  stripComments,
  verbSource,
  type Gate,
} from '../../scripts/apiKeyScopeRoutes';
import {
  ADMIN_ONLY_API_KEY_SCOPES,
  HAND_WRITTEN_API_KEY_SCOPE_ENDPOINTS,
  OPEN_TO_ANY_KEY_ENDPOINTS,
  USER_API_KEY_SCOPES,
  endpointKeys,
  type ApiKeyScopeOption,
} from './apiKeyScopes';
import { DERIVED_API_KEY_SCOPE_ENDPOINTS } from './apiKeyScopeEndpoints.generated';

// Only the gate lists are needed; keep dataLakeScopes from loading the services graph.
vi.mock('@bike4mind/services', () => ({}));
vi.mock('@server/auth/turnAuth', () => ({}));

/**
 * Every endpoint a scope lists must be gated by a check that admits it and nothing that makes the
 * entry misleading. The generated entries hold by construction; this mainly guards the hand-written
 * ones (overlay routes are skipped, as this repo cannot see them). How a route's checks are read is
 * documented in scripts/apiKeyScopeRoutes.ts.
 */

/**
 * Scopes a key may hold in place of the claimed one without the claim misleading: the family's own
 * read gate already says these keys may read. Mirrors the shared lists, so it cannot drift from them.
 */
const IMPLIED_BY: Partial<Record<ApiKeyScope, readonly ApiKeyScope[]>> = {
  [ApiKeyScope.DATALAKE_READ]: dataLakeScopes.DATA_LAKE_READ_SCOPES,
  // No shared list for Hearth; every Hearth door that admits read also admits write (pinned below).
  [ApiKeyScope.HEARTH_READ]: [ApiKeyScope.HEARTH_WRITE],
};

type Claim = { scope: ApiKeyScope; endpoint: string; method: string; path: string };

/**
 * Why `scope` claiming the route is false, or undefined when it holds. `claimants` are the scopes
 * whose catalogue entries claim the same route. A door runs before every in-handler check, so a
 * helper admitting the scope cannot vouch for it past a door that refuses it.
 */
function verifyGates(
  scope: ApiKeyScope,
  doors: Gate[],
  gates: Gate[],
  claimants: ReadonlySet<ApiKeyScope>
): string | undefined {
  if (doors.length > 0 && !doors.some(d => d.has(scope))) return 'the route door refuses the scope';
  const fits = (other: ApiKeyScope) =>
    other === scope || other === ApiKeyScope.ADMIN || claimants.has(other) || !!IMPLIED_BY[scope]?.includes(other);
  const admitting = gates.filter(g => g.has(scope));
  if (admitting.length === 0) return 'no gate on this route admits the scope';
  if (admitting.some(g => [...g].every(fits))) return undefined;
  const loosest = admitting.map(g => [...g].filter(s => !fits(s))).sort((a, b) => a.length - b.length)[0];
  return `every gate admitting it also admits [${loosest.join(', ')}], which claim no access here`;
}

const claimsOf = (catalog: ApiKeyScopeOption[]): Claim[] =>
  catalog.flatMap(({ value, endpoints }) =>
    endpoints.flatMap(endpoint => {
      const parsed = parseEndpoint(endpoint);
      return parsed
        ? parsed.methods.map(method => ({ scope: value as ApiKeyScope, endpoint, method, path: parsed.path }))
        : [];
    })
  );

const CATALOGUE = [...USER_API_KEY_SCOPES, ...ADMIN_ONLY_API_KEY_SCOPES];
const CLAIMS = claimsOf(CATALOGUE);
const CHECKED = CLAIMS.filter(c => !isOverlayPath(c.path)).map(claim => ({
  claim,
  route: gatesForRoute(claim.method, claim.path),
}));

// Keyed per verb, not per file: in a mixed read/write door the read claim on GET must not let the
// broad door alone vouch for the write claim on POST.
const claimantsKey = (claim: Claim, routeKey: string) => `${routeKey} ${claim.method}`;
const CLAIMANTS = new Map<string, Set<ApiKeyScope>>();
for (const { claim, route } of CHECKED) {
  if (route.key === undefined) continue;
  const key = claimantsKey(claim, route.key);
  CLAIMANTS.set(key, (CLAIMANTS.get(key) ?? new Set<ApiKeyScope>()).add(claim.scope));
}

describe('apiKeyScopes endpoint claims', () => {
  it('ignores a trailing qualifier when parsing an endpoint', () => {
    expect(parseEndpoint('PATCH /api/admin/release-notes/:id (video only)')).toEqual({
      methods: ['PATCH'],
      path: '/api/admin/release-notes/:id',
    });
  });

  it('treats a handler bound to a baseApi variable as serving its verb', () => {
    const source = 'const api = baseApi({});\napi.get(handler);';
    expect(servesVerb(source, 'GET')).toBe(true);
    expect(servesVerb(source, 'POST')).toBe(false);
  });

  it('finds no export name shared by two scope modules, which would shadow one gate list', () => {
    const names = SCOPE_MODULES.flatMap(m => Object.keys(m));
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it('serves a verb a req.method check names, not one an outbound call names', () => {
    expect(servesVerb("if (req.method !== 'POST') return res.status(405).end();", 'POST')).toBe(true);
    expect(servesVerb("switch (req.method) {\n  case 'PUT':\n    break;\n}", 'PUT')).toBe(true);
    expect(servesVerb("if (!['GET', 'HEAD'].includes(req.method)) return;", 'GET')).toBe(true);
    expect(servesVerb("await fetch(url, { method: 'POST', body });", 'POST')).toBe(false);
  });

  it('parses every endpoint entry, or it is prose that names no /api/ path', () => {
    for (const { value, endpoints } of [...USER_API_KEY_SCOPES, ...ADMIN_ONLY_API_KEY_SCOPES]) {
      for (const endpoint of endpoints) {
        if (!parseEndpoint(endpoint)) {
          expect(endpoint, `${value}: malformed endpoint entry`).not.toMatch(/\/api\//);
        }
      }
    }
  });

  it.each(Object.entries(OFF_PAGES_ROUTES))('%s is still handled by %s', (endpoint, file) => {
    const routePath = parseEndpoint(endpoint)!.path;
    expect(readFileSync(path.join(CLIENT_DIR, file), 'utf8')).toContain(routePath);
    expect(
      resolvePageFile(routePath),
      `${routePath} now has a pages/ route; drop it from OFF_PAGES_ROUTES`
    ).toBeUndefined();
  });

  it.each(CHECKED.map(({ claim, route }) => [claim.scope, `${claim.method} ${claim.path}`, claim, route] as const))(
    '%s really gates %s',
    (_scope, _endpoint, claim, route) => {
      const problem =
        route.key === undefined
          ? route.problem
          : verifyGates(claim.scope, route.doors, route.gates, CLAIMANTS.get(claimantsKey(claim, route.key))!);
      expect(problem, `${claim.scope} claims "${claim.endpoint}"`).toBeUndefined();
    }
  );

  it.each([...OPEN_TO_ANY_KEY_ENDPOINTS])('%s is still open to any key, and listed under no scope', endpoint => {
    const { methods, path: routePath } = parseEndpoint(endpoint)!;
    const contract = CONTRACTS.find(
      c => c.method.toUpperCase() === methods[0] && normalizePath(c.path) === normalizePath(routePath)
    );
    expect(contract?.scopes ?? [], `${endpoint} has a contract scope door`).toEqual([]);
    const file = resolvePageFile(routePath);
    expect(file, `${endpoint} has no pages/ route`).toBeDefined();
    const code = stripComments(readFileSync(file!, 'utf8'));
    expect(code, `${endpoint} now declares a route-level scope door`).not.toMatch(/\brequiredScopes\b/);
    // Listed once in the Scopes tab instead: under one scope it would read as that scope's gate.
    expect(
      CLAIMS.some(c => `${c.method} ${c.path}` === endpoint),
      `${endpoint} is listed under a scope`
    ).toBe(false);
  });

  it.each([...HAND_WRITTEN_API_KEY_SCOPE_ENDPOINTS])(
    '%s lists by hand nothing the generator already lists',
    (scope, hand) => {
      // A plain hand entry the generator covers would go stale beside it; one with a qualifier
      // (`(video only)`) is kept, as it says something the generated entry cannot.
      const derived = new Set(
        ((DERIVED_API_KEY_SCOPE_ENDPOINTS as Partial<Record<string, readonly string[]>>)[scope] ?? []).flatMap(
          endpointKeys
        )
      );
      const redundant = hand.filter(
        entry =>
          !/\(.*\)$/.test(entry) && endpointKeys(entry).length > 0 && endpointKeys(entry).every(k => derived.has(k))
      );
      expect(redundant, `${scope}: drop these hand entries, the generator lists them`).toEqual([]);
    }
  );

  it('lets a qualified hand entry replace only the generated methods it names', () => {
    const row = ADMIN_ONLY_API_KEY_SCOPES.find(r => r.value === ApiKeyScope.RELEASE_NOTES_WRITE)!;
    expect(row.endpoints).toContain('PATCH /api/admin/release-notes/:id (video only)');
    expect(row.endpoints.flatMap(endpointKeys).filter(k => k === 'PATCH /api/admin/release-notes/:')).toHaveLength(1);
    expect(row.endpoints).toContain('GET /api/admin/release-notes');
  });

  it('skips only claims on overlay routes', () => {
    // Pins the skip list to routes this repo genuinely cannot see: if one of these paths gains a
    // page here, its claims must be verified rather than waved through.
    for (const claim of CLAIMS.filter(c => isOverlayPath(c.path))) {
      expect(resolvePageFile(claim.path), `${claim.endpoint} is served here, not by an overlay`).toBeUndefined();
    }
  });
});

describe('the gate rule itself', () => {
  const share = ApiKeyScope.DATALAKE_SHARE;
  // The shape of pages/api/data-lakes/ownership-offers/[offerId]/accept.ts: a broad door, then the
  // narrow check the share claim actually rests on.
  const door = 'const handler = baseApi({ requiredScopes: DATA_LAKE_READ_OR_SHARE_SCOPES }).post(';
  const narrow = 'assertDataLakeShareScope(req);';

  it('derives the helper gates routes call in-handler', () => {
    expect([...HELPERS.get('assertDataLakeShareScope')!]).toEqual([share]);
    expect([...HELPERS.get('assertDataLakeTagWriteScope')!]).toEqual([ApiKeyScope.DATALAKE_WRITE]);
    expect([...HELPERS.get('verifyEmbedApiKey')!]).toEqual([ApiKeyScope.EMBED_CHAT]);
  });

  it('counts neither an import, a non-throwing probe, nor a scope array that enforces nothing', () => {
    const imported = "import { DATA_LAKE_SHARE_SCOPES } from '@server/dataLakes/dataLakeScopes';\n";
    expect(gatesIn(stripComments(imported), HELPERS)).toEqual([]);
    expect(HELPERS.has('holdsDataLakeReadScope')).toBe(false);
    const payload =
      'res.json({ grants: [ApiKeyScope.DATALAKE_SHARE] }); keys.filter(k => k.includes(ApiKeyScope.ADMIN));';
    expect(gatesIn(payload, HELPERS)).toEqual([]);
  });

  it('refuses to read an all-of alsoRequiredScopes gate as an any-of one', () => {
    const code = 'baseApi({ requiredScopes: [ApiKeyScope.ADMIN], alsoRequiredScopes: [ApiKeyScope.READ_FILES] })';
    expect(() => gatesIn(code, HELPERS)).toThrow(/all-of/);
  });

  it('resolves a scope list declared in the route file itself', () => {
    const code = 'const WRITE = [ApiKeyScope.HEARTH_WRITE];\nassertApiKeyScope(req, WRITE, "no");';
    expect(gatesIn(code, HELPERS)).toEqual([new Set([ApiKeyScope.HEARTH_WRITE])]);
  });

  it('leaves a same-file list unresolved when its declaration transforms it', () => {
    const code = 'const WRITE = [ApiKeyScope.HEARTH_WRITE].filter(Boolean);\nassertApiKeyScope(req, WRITE, "no");';
    expect(gatesIn(code, HELPERS)).toEqual([]);
  });

  it('fails a claim on a verb the route file does not serve', () => {
    const claim: Claim = {
      scope: ApiKeyScope.READ_AGENTS,
      endpoint: 'PATCH /api/agents',
      method: 'PATCH',
      path: '/api/agents',
    };
    expect(gatesForRoute(claim.method, claim.path)).toMatchObject({
      problem: expect.stringMatching(/does not serve this method/),
    });
  });

  it('reads an in-handler check only for the verb whose chain link holds it', () => {
    const code = [
      'const handler = baseApi({ requiredScopes: PROJECTS_READ_OR_WRITE_SCOPES })',
      '  .get(async (req, res) => {',
      '    assertProjectsWriteScope(req);',
      '  })',
      '  .put(async (req, res) => {',
      '    res.end();',
      '  });',
      '',
      'export default handler;',
    ].join('\n');
    const door = new Set([ApiKeyScope.READ_PROJECTS, ApiKeyScope.WRITE_PROJECTS]);
    expect(gatesIn(verbSource(code, 'GET'), HELPERS)).toEqual([door, new Set([ApiKeyScope.WRITE_PROJECTS])]);
    expect(gatesIn(verbSource(code, 'PUT'), HELPERS)).toEqual([door]);
  });

  it('accepts a broad door backed by the narrow check', () => {
    expect(
      verifyGates(share, doorsIn(`${door}\n${narrow}`), gatesIn(`${door}\n${narrow}`, HELPERS), new Set([share]))
    ).toBeUndefined();
  });

  it('rejects the broad door alone when no other scope claims the same verb', () => {
    expect(verifyGates(share, doorsIn(door), gatesIn(door, HELPERS), new Set([share]))).toMatch(/also admits/);
  });

  it('counts claimants per verb, so a read claim on GET cannot vouch for a write claim on POST', () => {
    const post = [...CLAIMANTS].find(([key]) => key === 'pages/api/projects/index.ts POST')?.[1];
    expect(post).toContain(ApiKeyScope.WRITE_PROJECTS);
    expect(post).not.toContain(ApiKeyScope.READ_PROJECTS);
    const door = 'requiredScopes: PROJECTS_READ_OR_WRITE_SCOPES';
    expect(verifyGates(ApiKeyScope.WRITE_PROJECTS, doorsIn(door), gatesIn(door, HELPERS), post!)).toMatch(
      /also admits/
    );
  });

  it('rejects a claim the door refuses, even when an in-handler check admits it', () => {
    // The shape of pages/api/files/createFabFile.ts: a files:write door, then a lake-tag write check.
    const code = 'baseApi({ requiredScopes: FILES_WRITE_SCOPES }).post(\nassertDataLakeTagWriteScope(req);';
    const lakeWrite = ApiKeyScope.DATALAKE_WRITE;
    expect(verifyGates(lakeWrite, doorsIn(code), gatesIn(code, HELPERS), new Set([lakeWrite]))).toMatch(/door refuses/);
  });

  it.each(Object.entries(HAND_HELPERS))('%s throws and checks exactly the scopes it is credited with', (name, h) => {
    const code = stripComments(readFileSync(path.join(CLIENT_DIR, h.file), 'utf8'));
    const body = new RegExp(String.raw`^export (?:async )?function ${name}\b[\s\S]*?^\}[ \t]*$`, 'm').exec(code)?.[0];
    expect(body, `${name} not found in ${h.file}`).toBeDefined();
    expect(body).toMatch(/\bthrow\b/);
    const named = [...body!.matchAll(/\bApiKeyScope\.([A-Z_]+)\b/g)].map(([, m]) => scopeOf(m));
    expect(new Set(named)).toEqual(new Set(h.scopes));
  });

  it('keeps hearth:write admitted wherever hearth:read is, which IMPLIED_BY relies on', () => {
    const dir = path.join(PAGES_DIR, 'api/hearth');
    const files = readdirSync(dir).filter(f => /\.tsx?$/.test(f));
    const readGates = files.flatMap(f =>
      gatesIn(stripComments(readFileSync(path.join(dir, f), 'utf8')), HELPERS).filter(g =>
        g.has(ApiKeyScope.HEARTH_READ)
      )
    );
    expect(readGates.length).toBeGreaterThan(0);
    for (const gate of readGates) expect(gate).toContain(ApiKeyScope.HEARTH_WRITE);
  });

  it('accepts a door every member of which claims the route or implies the scope', () => {
    const both = new Set([ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS]);
    const literal = 'requiredScopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS, ApiKeyScope.ADMIN]';
    expect(verifyGates(ApiKeyScope.READ_NOTEBOOKS, doorsIn(literal), gatesIn(literal, HELPERS), both)).toBeUndefined();
    const lakeRead = 'requiredScopes: DATA_LAKE_READ_SCOPES';
    expect(
      verifyGates(
        ApiKeyScope.DATALAKE_READ,
        doorsIn(lakeRead),
        gatesIn(lakeRead, HELPERS),
        new Set([ApiKeyScope.DATALAKE_READ])
      )
    ).toBeUndefined();
  });
});
