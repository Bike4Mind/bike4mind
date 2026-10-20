// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ApiKeyScope, CONTRACTS } from '@bike4mind/common';
import * as agentScopes from '@server/agents/agentScopes';
import * as dataLakeScopes from '@server/dataLakes/dataLakeScopes';
import * as fileScopes from '@server/files/fileScopes';
import * as projectScopes from '@server/projects/projectScopes';
import { ADMIN_ONLY_API_KEY_SCOPES, USER_API_KEY_SCOPES, type ApiKeyScopeOption } from './apiKeyScopes';

/**
 * Pins the direction of the catalogue's `endpoints` lists that misleads a user: every endpoint a
 * scope CLAIMS must really be gated on that scope. The lists are still not exhaustive - a scope can
 * open routes it does not name - and nothing here checks that half.
 *
 * A gate is the set of scopes one check admits (OR semantics): a contract's `scopes`, a scope array
 * literal, a shared `*_SCOPES` list, or a call to a helper such as `assertDataLakeShareScope`. A
 * claim holds when some gate on its route admits the scope AND admits nothing that would make the
 * claim misleading - only scopes that claim the same route, `admin:*`, or scopes the repo's own
 * lists say imply it. So a broad door alone (`DATA_LAKE_READ_OR_SHARE_SCOPES`) cannot vouch for
 * `datalake:share`; the narrower in-handler check must be there too.
 *
 * A contract's door is per method; the in-handler checks, like every pages/ route's, are read per
 * FILE from source with comments stripped, so a narrow check guarding one verb vouches for every
 * verb the file serves. That is the price of reading source instead of booting every route.
 */

const CLIENT_DIR = path.resolve(__dirname, '../..');
const PAGES_DIR = path.join(CLIENT_DIR, 'pages');

// Routes this repo serves outside pages/ (CloudFront sends them to the chat-completion container;
// see infra/chatCompletion.ts), keyed by path, valued by the source file that handles them.
const OFF_PAGES_ROUTES: Record<string, string> = {
  '/api/embed/chat': 'server/chatCompletion/external/embedRoute.ts',
};

// Routes served by premium overlays, which are not checked out here; their claims cannot be
// verified in this repo and are skipped rather than failed.
const OVERLAY_PATH_PREFIXES = ['/api/premium-overwatch/', '/api/overwatch/marketing-reports'];

// Files whose exported functions are scope-check helpers a route may call instead of naming a list.
const HELPER_SOURCES = [
  'server/agents/agentScopes.ts',
  'server/dataLakes/dataLakeScopes.ts',
  'server/files/fileScopes.ts',
  'server/projects/projectScopes.ts',
  'server/cli/auth.ts',
];

/**
 * Scopes a key may hold in place of the claimed one without the claim misleading: the family's own
 * read gate already says these keys may read. Mirrors the shared lists, so it cannot drift from them.
 */
const IMPLIED_BY: Partial<Record<ApiKeyScope, readonly ApiKeyScope[]>> = {
  [ApiKeyScope.DATALAKE_READ]: dataLakeScopes.DATA_LAKE_READ_SCOPES,
};

type Gate = ReadonlySet<ApiKeyScope>;

const SCOPE_BY_MEMBER = new Map<string, ApiKeyScope>(Object.entries(ApiKeyScope));
const SCOPE_VALUES = new Set<string>(Object.values(ApiKeyScope));

// Exported gate lists a route can pass to baseApi or assertApiKeyScope, by export name. A route
// gated through a list from a module not imported here fails its claim, so add the module.
const GATE_LISTS = new Map<string, readonly ApiKeyScope[]>(
  Object.entries({ ...agentScopes, ...dataLakeScopes, ...fileScopes, ...projectScopes }).filter(
    (entry): entry is [string, ApiKeyScope[]] =>
      Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(v => SCOPE_VALUES.has(v))
  )
);

// Also drops `required_scopes: ...` 403 payloads: they report a gate, they do not enforce one.
const stripComments = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/required_scopes:\s*(\[[^[\]]*\]|[A-Z_]+)/g, '');

const scopeOf = (member: string) => SCOPE_BY_MEMBER.get(member);

/**
 * Every gate `code` declares: each scope array literal (spreads of shared lists resolved), then
 * each shared list, helper call or `ApiKeyScope.X` left outside those literals as a gate of its own.
 */
function gatesIn(code: string, helpers: ReadonlyMap<string, Gate>): Gate[] {
  const gates: Gate[] = [];
  const outsideArrays = code.replace(/\[([^[\]]*)\]/g, (literal, inner: string) => {
    const scopes = new Set<ApiKeyScope>();
    for (const [, member] of inner.matchAll(/\bApiKeyScope\.([A-Z_]+)\b/g)) {
      const scope = scopeOf(member);
      if (scope) scopes.add(scope);
    }
    for (const [, name] of inner.matchAll(/\.\.\.([A-Z_]+)\b/g)) GATE_LISTS.get(name)?.forEach(s => scopes.add(s));
    if (scopes.size === 0) return literal;
    gates.push(scopes);
    return '[]';
  });
  for (const [, member] of outsideArrays.matchAll(/\bApiKeyScope\.([A-Z_]+)\b/g)) {
    const scope = scopeOf(member);
    if (scope) gates.push(new Set([scope]));
  }
  for (const [name, list] of GATE_LISTS) {
    if (new RegExp(`\\b${name}\\b`).test(outsideArrays)) gates.push(new Set(list));
  }
  for (const [name, gate] of helpers) {
    if (new RegExp(`\\b${name}\\(`).test(outsideArrays)) gates.push(gate);
  }
  return gates;
}

/** Exported helpers whose body runs exactly one scope check, mapped to that check's gate. */
function loadHelpers(): Map<string, Gate> {
  const bodies = new Map<string, string>();
  for (const file of HELPER_SOURCES) {
    const code = stripComments(readFileSync(path.join(CLIENT_DIR, file), 'utf8'));
    for (const [body, name] of code.matchAll(/export (?:async )?function (\w+)\b[\s\S]*?(?=\nexport |$)/g)) {
      bodies.set(name, body.slice(body.indexOf('{')));
    }
  }
  // A helper may delegate to another (assertDataLakeTagWriteScope -> assertDataLakeWriteScope), so
  // resolve until nothing new settles.
  const helpers = new Map<string, Gate>();
  for (let settled = -1; settled !== helpers.size;) {
    settled = helpers.size;
    for (const [name, body] of bodies) {
      if (helpers.has(name)) continue;
      const gates = gatesIn(body, helpers);
      if (gates.length === 1) helpers.set(name, gates[0]);
    }
  }
  return helpers;
}

const HELPERS = loadHelpers();

const normalizePath = (p: string) => p.replace(/\{[^}]+\}|:[A-Za-z_]+/g, ':param');

/** Parses `GET /api/x/:id` or `PATCH|DELETE /api/x/:id`; undefined for prose entries. */
function parseEndpoint(endpoint: string): { methods: string[]; path: string } | undefined {
  const match = /^([A-Z|]+) (\/api\/\S+)$/.exec(endpoint);
  return match ? { methods: match[1].split('|'), path: match[2] } : undefined;
}

/** The pages/ file that serves `routePath`, preferring a literal segment over a dynamic one. */
function resolvePageFile(routePath: string): string | undefined {
  const segments = routePath.split('/').filter(Boolean);
  const walk = (dir: string, rest: string[]): string | undefined => {
    if (rest.length === 0) {
      const index = path.join(dir, 'index.ts');
      return existsSync(index) ? index : undefined;
    }
    const [head, ...tail] = rest;
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    // `[...x]` catch-alls are excluded: v1's unmatched-path 404 would otherwise "serve" any typo.
    const dynamic = entries.filter(e => /^\[[^.\]][^\]]*\](\.ts)?$/.test(e));
    const names = head.startsWith(':') ? dynamic.map(e => e.replace(/\.ts$/, '')) : [head];
    for (const name of new Set(names)) {
      if (tail.length === 0 && existsSync(path.join(dir, `${name}.ts`))) return path.join(dir, `${name}.ts`);
      const sub = path.join(dir, name);
      if (existsSync(sub) && statSync(sub).isDirectory()) {
        const found = walk(sub, tail);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(PAGES_DIR, segments);
}

type Claim = { scope: ApiKeyScope; endpoint: string; method: string; path: string };

/** Where a claim is checked: one contract (one method), or one source file (every method it serves). */
type Route = { key: string; gates: Gate[] } | { key?: undefined; problem: string };

function routeOf(claim: Claim): Route {
  const contract = CONTRACTS.find(
    c => c.method.toUpperCase() === claim.method && normalizePath(c.path) === normalizePath(claim.path)
  );
  const offPages = OFF_PAGES_ROUTES[claim.path];
  const file = offPages ? path.join(CLIENT_DIR, offPages) : resolvePageFile(claim.path);
  const fileGates = file ? gatesIn(stripComments(readFileSync(file, 'utf8')), HELPERS) : [];
  // A contract's scopes are the door; the handler behind it may narrow a scope the door admits
  // (POST /api/v1/sessions lets ai:generate in, then requires notebooks:write for most bodies).
  if (contract) {
    return { key: `contract ${contract.operationId}`, gates: [new Set(contract.scopes ?? []), ...fileGates] };
  }
  if (!file) return { problem: 'no contract or pages/ route serves this path' };
  return { key: path.relative(CLIENT_DIR, file), gates: fileGates };
}

/**
 * Why `scope` claiming the route is false, or undefined when it holds. `claimants` are the scopes
 * whose catalogue entries claim the same route.
 */
function verifyGates(scope: ApiKeyScope, gates: Gate[], claimants: ReadonlySet<ApiKeyScope>): string | undefined {
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
      return parsed ? parsed.methods.map(method => ({ scope: value, endpoint, method, path: parsed.path })) : [];
    })
  );

const isOverlay = (p: string) => OVERLAY_PATH_PREFIXES.some(prefix => p.startsWith(prefix));
const CLAIMS = claimsOf([...USER_API_KEY_SCOPES, ...ADMIN_ONLY_API_KEY_SCOPES]);
const CHECKED = CLAIMS.filter(c => !isOverlay(c.path)).map(claim => ({ claim, route: routeOf(claim) }));

const CLAIMANTS = new Map<string, Set<ApiKeyScope>>();
for (const { claim, route } of CHECKED) {
  if (route.key === undefined) continue;
  const set = CLAIMANTS.get(route.key) ?? new Set<ApiKeyScope>();
  CLAIMANTS.set(route.key, set.add(claim.scope));
}

describe('apiKeyScopes endpoint claims', () => {
  it('parses every endpoint entry, or it is prose that names no /api/ path', () => {
    for (const { value, endpoints } of [...USER_API_KEY_SCOPES, ...ADMIN_ONLY_API_KEY_SCOPES]) {
      for (const endpoint of endpoints) {
        if (!parseEndpoint(endpoint)) {
          expect(endpoint, `${value}: malformed endpoint entry`).not.toMatch(/\/api\//);
        }
      }
    }
  });

  it.each(Object.entries(OFF_PAGES_ROUTES))('%s is still handled by %s', (routePath, file) => {
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
        route.key === undefined ? route.problem : verifyGates(claim.scope, route.gates, CLAIMANTS.get(route.key)!);
      expect(problem, `${claim.scope} claims "${claim.endpoint}"`).toBeUndefined();
    }
  );

  it('skips only claims on overlay routes', () => {
    // Pins the skip list to routes this repo genuinely cannot see: if one of these paths gains a
    // page here, its claims must be verified rather than waved through.
    for (const claim of CLAIMS.filter(c => isOverlay(c.path))) {
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

  it('accepts a broad door backed by the narrow check', () => {
    expect(verifyGates(share, gatesIn(`${door}\n${narrow}`, HELPERS), new Set([share]))).toBeUndefined();
  });

  it('rejects the broad door alone, so deleting the narrow check fails the claim', () => {
    expect(verifyGates(share, gatesIn(door, HELPERS), new Set([share]))).toMatch(/also admits/);
  });

  it('accepts a door every member of which claims the route or implies the scope', () => {
    const both = new Set([ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS]);
    const literal = 'requiredScopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS, ApiKeyScope.ADMIN]';
    expect(verifyGates(ApiKeyScope.READ_NOTEBOOKS, gatesIn(literal, HELPERS), both)).toBeUndefined();
    const lakeRead = 'requiredScopes: DATA_LAKE_READ_SCOPES';
    expect(
      verifyGates(ApiKeyScope.DATALAKE_READ, gatesIn(lakeRead, HELPERS), new Set([ApiKeyScope.DATALAKE_READ]))
    ).toBeUndefined();
  });
});
