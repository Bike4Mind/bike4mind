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
 * scope CLAIMS must really accept that scope. The lists are still not exhaustive - a scope can open
 * routes it does not name - and nothing here checks that half.
 *
 * A claim is verified against the public contract for that method + path when there is one, and
 * otherwise against the Next.js page that serves the path: the scope must appear in that file's
 * code (comments stripped), directly as `ApiKeyScope.X` or through one of the shared `*_SCOPES`
 * gate lists below. That is per file, not per verb, so a file that gates one verb does not prove
 * another - the price of reading source instead of booting every route.
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

const SCOPE_BY_MEMBER = new Map<string, ApiKeyScope>(Object.entries(ApiKeyScope));
const SCOPE_VALUES = new Set<string>(Object.values(ApiKeyScope));

// Key verifiers a route calls in-handler instead of the baseApi gate, and the scope each demands.
const GATE_HELPERS: Record<string, { file: string; scopes: readonly ApiKeyScope[] }> = {
  verifyEmbedApiKey: { file: 'server/cli/auth.ts', scopes: [ApiKeyScope.EMBED_CHAT] },
  verifyEmbedKeyById: { file: 'server/cli/auth.ts', scopes: [ApiKeyScope.EMBED_CHAT] },
};

// Exported gate lists a route can pass to baseApi or assertApiKeyScope, by export name. A route
// gated through a list from a module not imported here fails its claim, so add the module.
const GATE_LISTS = new Map<string, readonly ApiKeyScope[]>(
  Object.entries({ ...agentScopes, ...dataLakeScopes, ...fileScopes, ...projectScopes }).filter(
    (entry): entry is [string, ApiKeyScope[]] =>
      Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(v => SCOPE_VALUES.has(v))
  )
);

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

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Every scope a route file's code names, directly or through a shared gate list. */
function scopesNamedIn(file: string): Set<ApiKeyScope> {
  const code = stripComments(readFileSync(file, 'utf8'));
  const scopes = new Set<ApiKeyScope>();
  for (const [, member] of code.matchAll(/\bApiKeyScope\.([A-Z_]+)\b/g)) {
    const scope = SCOPE_BY_MEMBER.get(member);
    if (scope) scopes.add(scope);
  }
  const lists = [...GATE_LISTS, ...Object.entries(GATE_HELPERS).map(([name, h]) => [name, h.scopes] as const)];
  for (const [name, list] of lists) {
    if (new RegExp(`\\b${name}\\b`).test(code)) list.forEach(s => scopes.add(s));
  }
  return scopes;
}

type Claim = { scope: ApiKeyScope; endpoint: string; method: string; path: string };

const claimsOf = (catalog: ApiKeyScopeOption[]): Claim[] =>
  catalog.flatMap(({ value, endpoints }) =>
    endpoints.flatMap(endpoint => {
      const parsed = parseEndpoint(endpoint);
      return parsed ? parsed.methods.map(method => ({ scope: value, endpoint, method, path: parsed.path })) : [];
    })
  );

const CLAIMS = claimsOf([...USER_API_KEY_SCOPES, ...ADMIN_ONLY_API_KEY_SCOPES]);
const isOverlay = (p: string) => OVERLAY_PATH_PREFIXES.some(prefix => p.startsWith(prefix));

/** Why `claim` is false, or undefined when the route it names really accepts its scope. */
function verify(claim: Claim): string | undefined {
  const contract = CONTRACTS.find(
    c => c.method.toUpperCase() === claim.method && normalizePath(c.path) === normalizePath(claim.path)
  );
  if (contract) {
    return contract.scopes?.includes(claim.scope)
      ? undefined
      : `contract ${contract.operationId} declares [${contract.scopes?.join(', ') ?? ''}]`;
  }
  const offPages = OFF_PAGES_ROUTES[claim.path];
  const file = offPages ? path.join(CLIENT_DIR, offPages) : resolvePageFile(claim.path);
  if (!file) return 'no contract or pages/ route serves this path';
  return scopesNamedIn(file).has(claim.scope)
    ? undefined
    : `${path.relative(CLIENT_DIR, file)} never names this scope in its gate`;
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

  it.each(Object.entries(GATE_HELPERS))('%s really demands the scope it is credited with', (name, helper) => {
    const code = stripComments(readFileSync(path.join(CLIENT_DIR, helper.file), 'utf8'));
    const body = new RegExp(`export (?:async )?function ${name}\\b[\\s\\S]*?(?=\\nexport |$)`).exec(code)?.[0];
    expect(body, `${name} not found in ${helper.file}`).toBeDefined();
    for (const scope of helper.scopes) {
      const member = [...SCOPE_BY_MEMBER].find(([, v]) => v === scope)?.[0];
      expect(body, `${name} must check ${scope}`).toMatch(new RegExp(`\\bApiKeyScope\\.${member}\\b`));
    }
  });

  it.each(Object.entries(OFF_PAGES_ROUTES))('%s is still handled by %s', (routePath, file) => {
    expect(readFileSync(path.join(CLIENT_DIR, file), 'utf8')).toContain(routePath);
    expect(
      resolvePageFile(routePath),
      `${routePath} now has a pages/ route; drop it from OFF_PAGES_ROUTES`
    ).toBeUndefined();
  });

  it.each(CLAIMS.filter(c => !isOverlay(c.path)).map(c => [c.scope, `${c.method} ${c.path}`, c] as const))(
    '%s really gates %s',
    (_scope, _endpoint, claim) => {
      expect(verify(claim), `${claim.scope} claims "${claim.endpoint}"`).toBeUndefined();
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
