// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ApiKeyScope, CONTRACTS } from '@bike4mind/common';
import * as agentScopes from '@server/agents/agentScopes';
import * as dataLakeScopes from '@server/dataLakes/dataLakeScopes';
import * as fileScopes from '@server/files/fileScopes';
import * as projectScopes from '@server/projects/projectScopes';
import {
  ADMIN_ONLY_API_KEY_SCOPES,
  USER_API_KEY_SCOPES,
  type ApiKeyScopeOption,
} from '@bike4mind/server-utils/app/constants/apiKeyScopes';

// Only the gate lists are needed; keep dataLakeScopes from loading the services graph.
vi.mock('@bike4mind/services', () => ({}));
vi.mock('@server/auth/turnAuth', () => ({}));

/**
 * Every endpoint a scope CLAIMS must be gated by a check that admits it and nothing that makes the
 * claim misleading; routes a scope opens without listing them are not checked. Who else claims a
 * route is counted per verb, and so are in-handler checks where the file chains its handlers
 * (`.get(..).post(..)`): a check inside one verb's link vouches for that verb only. Anything outside
 * the links (the door, a local function a link calls) counts for every verb, and a file with no
 * links (a `req.method` branch) is read whole, so a check on one branch still vouches for them all.
 */

const CLIENT_DIR = path.resolve(__dirname, '../..');
const PAGES_DIR = path.join(CLIENT_DIR, 'pages');

// Routes this repo serves outside pages/ (CloudFront sends them to the chat-completion container;
// see infra/chatCompletion.ts), keyed by path, valued by the source file that handles them.
const OFF_PAGES_ROUTES: Record<string, string> = {
  '/api/embed/chat': 'server/chatCompletion/external/embedRoute.ts',
};

// Verbs deliberately open to every non-confined key, whatever its scopes, so any scope may list
// them. Pinned below to have no scope door at all, so an entry cannot outlive the route opening up.
const OPEN_TO_ANY_KEY = new Set(['GET /api/sessions']);

// Routes served by premium overlays, which are not checked out here; their claims cannot be
// verified in this repo and are skipped rather than failed.
const OVERLAY_PATH_PREFIXES = ['/api/premium-overwatch/', '/api/overwatch/marketing-reports', '/api/premium-bob/'];

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
  // No shared list for Hearth; every Hearth door that admits read also admits write (pinned below).
  [ApiKeyScope.HEARTH_READ]: [ApiKeyScope.HEARTH_WRITE],
};

// Helpers that check scopes by hand (`.includes` + throw) rather than through an enforcing site, so
// they cannot be derived; each is pinned below to throw and to name exactly these scopes.
const HAND_HELPERS: Record<string, { file: string; scopes: readonly ApiKeyScope[] }> = {
  assertHearthWriteScope: { file: 'server/utils/hearthWire.ts', scopes: [ApiKeyScope.HEARTH_WRITE, ApiKeyScope.ADMIN] },
};

type Gate = ReadonlySet<ApiKeyScope>;

const SCOPE_BY_MEMBER = new Map<string, ApiKeyScope>(Object.entries(ApiKeyScope));
const SCOPE_VALUES = new Set<string>(Object.values(ApiKeyScope));

// Exported gate lists a route can pass to baseApi or assertApiKeyScope, by export name. A route
// gated through a list from a module not imported here fails its claim, so add the module.
const SCOPE_MODULES = [agentScopes, dataLakeScopes, fileScopes, projectScopes];
const GATE_LISTS = new Map<string, readonly ApiKeyScope[]>(
  SCOPE_MODULES.flatMap(m => Object.entries(m)).filter(
    (entry): entry is [string, ApiKeyScope[]] =>
      Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(v => SCOPE_VALUES.has(v))
  )
);

// Also drops imports and `required_scopes: ...` 403 payloads: they name a gate, they do not enforce
// one. The line-comment pass also cuts a `//` inside a regex or mid-string, which can only drop a
// gate (a false fail), never invent one.
const stripComments = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/^import\b[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')
    .replace(/required_scopes:\s*(\[[^[\]]*\]|[A-Z_]+)/g, '');

const scopeOf = (member: string) => SCOPE_BY_MEMBER.get(member);

// The scope set a check enforces: a `[...]` literal or a list name.
const GATE_EXPR = String.raw`(\[[^[\]]*\]|[A-Za-z_$][\w$]*)`;

// Only sites that can deny: a route's or verifier's `requiredScopes`, and the list handed to
// `assertApiKeyScope`. A scope array elsewhere (a payload, a filter) is not a gate.
const ENFORCING_SITE = new RegExp(
  String.raw`\brequiredScopes\s*:\s*${GATE_EXPR}|\bassertApiKeyScope\(\s*[\w.]+\s*,\s*${GATE_EXPR}`,
  'g'
);

// A route's door: the scopes `baseApi` refuses a key without, before any in-handler check runs.
const DOOR_SITE = new RegExp(String.raw`\bbaseApi\(\s*\{[^{}]*?\brequiredScopes\s*:\s*${GATE_EXPR}`, 'g');

/** Resolves a gate expression to its scopes: literals, shared lists and lists declared in `code`. */
function listResolver(code: string) {
  const localLists = new Map<string, string>();
  // A list the declaration goes on to transform (`].filter(`, `].concat(`) is left unresolved.
  const declarations =
    /\bconst ([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*(\[[^[\]]*\])(?!(?:\s*as const)?\s*[.?[(+\-*/|&!<>=])/g;
  for (const [, name, literal] of code.matchAll(declarations)) {
    localLists.set(name, literal);
  }
  const resolve = (expr: string, seen = new Set<string>()): Set<ApiKeyScope> => {
    const scopes = new Set<ApiKeyScope>();
    if (!expr.startsWith('[')) {
      const local = localLists.get(expr);
      if (local && !seen.has(expr)) return resolve(local, seen.add(expr));
      GATE_LISTS.get(expr)?.forEach(s => scopes.add(s));
      return scopes;
    }
    for (const [, member] of expr.matchAll(/\bApiKeyScope\.([A-Z_]+)\b/g)) {
      const scope = scopeOf(member);
      if (scope) scopes.add(scope);
    }
    for (const [, name] of expr.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) resolve(name, seen).forEach(s => scopes.add(s));
    return scopes;
  };
  return resolve;
}

/** Every gate `code` enforces: each enforcing site plus each call to a derived helper. */
function gatesIn(code: string, helpers: ReadonlyMap<string, Gate>): Gate[] {
  if (/\balsoRequiredScopes\b/.test(code)) {
    throw new Error('alsoRequiredScopes is an all-of gate, which this check does not model; teach gatesIn it');
  }
  const resolve = listResolver(code);
  const gates: Gate[] = [];
  for (const [, routeExpr, assertExpr] of code.matchAll(ENFORCING_SITE)) {
    const scopes = resolve(routeExpr ?? assertExpr);
    if (scopes.size > 0) gates.push(scopes);
  }
  for (const [name, gate] of helpers) {
    if (new RegExp(`\\b${name}\\(`).test(code)) gates.push(gate);
  }
  return gates;
}

/** The `baseApi` doors in `code`. A file may hold several (one per handler), so any one may admit. */
function doorsIn(code: string): Gate[] {
  const resolve = listResolver(code);
  return [...code.matchAll(DOOR_SITE)].map(([, expr]) => resolve(expr)).filter(door => door.size > 0);
}

/**
 * Exported helpers whose body enforces exactly one gate, mapped to it. A non-throwing probe like
 * `holdsDataLakeReadScope` enforces none, so it is not a gate.
 */
function loadHelpers(): Map<string, Gate> {
  const bodies = new Map<string, string>();
  for (const file of HELPER_SOURCES) {
    const code = stripComments(readFileSync(path.join(CLIENT_DIR, file), 'utf8'));
    for (const [body, name] of code.matchAll(/^export (?:async )?function (\w+)\b[\s\S]*?^\}[ \t]*$/gm)) {
      bodies.set(name, body.slice(body.indexOf('{')));
    }
  }
  // A helper may delegate to another (assertDataLakeTagWriteScope -> assertDataLakeWriteScope), so
  // resolve until nothing new settles.
  const helpers = new Map<string, Gate>(
    Object.entries(HAND_HELPERS).map(([name, { scopes }]) => [name, new Set(scopes)])
  );
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

/** Parses `GET /api/x/:id` or `PATCH|DELETE /api/x/:id`, ignoring a trailing `(qualifier)`; undefined for prose entries. */
function parseEndpoint(endpoint: string): { methods: string[]; path: string } | undefined {
  const match = /^([A-Z|]+) (\/api\/\S+)(?: \([^)]*\))?$/.exec(endpoint);
  return match ? { methods: match[1].split('|'), path: match[2] } : undefined;
}

const PAGE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * The handler chain links in `source` (`).post(`, `}).get<T>(`, or `api.get(` on a handler bound to
 * a variable), each running from its `.` to the next link or the end of its statement (the next
 * line starting in column 0 with anything but a closing bracket). Links anchor on the `)` they
 * follow, so `Promise.all(` and `headers.get(` are not links.
 */
function chainLinks(source: string): { verb: string; start: number; end: number }[] {
  const bound = [...source.matchAll(/\bconst (\w+)\s*=\s*baseApi\(/g)].map(m => String.raw`\b${m[1]}\s*`);
  const link = new RegExp(
    String.raw`(?:${[String.raw`\)\s*`, ...bound].join('|')})(\.(get|post|put|patch|delete|all)\s*[<(])`,
    'g'
  );
  const starts = [...source.matchAll(link)].map(m => ({ verb: m[2], start: m.index + m[0].length - m[1].length }));
  return starts.map(({ verb, start }, i) => {
    const next = starts[i + 1]?.start ?? source.length;
    const statementEnd = /\n(?=[^\s})\]])/g;
    statementEnd.lastIndex = start;
    const endMatch = statementEnd.exec(source);
    return { verb, start, end: Math.min(next, endMatch ? endMatch.index : source.length) };
  });
}

/** The part of `source` that can gate `method`: its own chain links plus everything outside any link. */
function verbSource(source: string, method: string): string {
  const lower = method.toLowerCase();
  const parts: string[] = [];
  let at = 0;
  for (const { verb, start, end } of chainLinks(source)) {
    parts.push(source.slice(at, start));
    if (verb === lower || verb === 'all') parts.push(source.slice(start, end));
    at = end;
  }
  parts.push(source.slice(at));
  return parts.join('\n');
}

/**
 * Whether `source` serves `method`: a handler chain link (see chainLinks), or a `req.method` check
 * (`req.method !== 'POST'`, `case 'POST'` under `switch (req.method)`, `[..].includes(req.method)`).
 * A bare `'POST'` (an outbound fetch's `method`) is not a check.
 */
function servesVerb(source: string, method: string): boolean {
  const lower = method.toLowerCase();
  if (chainLinks(source).some(l => l.verb === lower || l.verb === 'all')) return true;
  const verb = `['"]${method}['"]`;
  const methodChecks = [
    String.raw`\breq\.method\s*[!=]==?\s*${verb}`,
    String.raw`${verb}\s*[!=]==?\s*req\.method\b`,
    String.raw`\bswitch\s*\(\s*req\.method\s*\)[\s\S]*?\bcase\s+${verb}`,
    String.raw`\[[^[\]]*${verb}[^[\]]*\]\.includes\(\s*req\.method\b`,
  ];
  return new RegExp(methodChecks.join('|')).test(source);
}

/** The pages/ file that serves `routePath`, preferring a literal segment over a dynamic one. */
function resolvePageFile(routePath: string): string | undefined {
  const segments = routePath.split('/').filter(Boolean);
  const fileFor = (base: string) => PAGE_EXTENSIONS.map(ext => `${base}${ext}`).find(f => existsSync(f));
  const walk = (dir: string, rest: string[]): string | undefined => {
    if (rest.length === 0) return fileFor(path.join(dir, 'index'));
    const [head, ...tail] = rest;
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    // `[...x]` catch-alls are excluded: v1's unmatched-path 404 would otherwise "serve" any typo.
    const dynamic = entries.filter(e => /^\[[^.\]][^\]]*\](\.tsx?)?$/.test(e));
    const names = head.startsWith(':') ? dynamic.map(e => e.replace(/\.tsx?$/, '')) : [head];
    for (const name of new Set(names)) {
      const file = tail.length === 0 ? fileFor(path.join(dir, name)) : undefined;
      if (file) return file;
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

/** Where a claim is checked: one contract (one method), or one source file read for that method (see verbSource). */
type Route = { key: string; doors: Gate[]; gates: Gate[] } | { key?: undefined; problem: string };

function routeOf(claim: Claim): Route {
  const contract = CONTRACTS.find(
    c => c.method.toUpperCase() === claim.method && normalizePath(c.path) === normalizePath(claim.path)
  );
  const offPages = OFF_PAGES_ROUTES[claim.path];
  const file = offPages ? path.join(CLIENT_DIR, offPages) : resolvePageFile(claim.path);
  const source = file ? stripComments(readFileSync(file, 'utf8')) : '';
  const fileGates = file ? gatesIn(verbSource(source, claim.method), HELPERS) : [];
  // A contract's scopes are the door; the handler behind it may add an enforcing check of its own,
  // which counts too. (A `holdsApiKeyScope` probe plus a hand-thrown 403 does not.)
  if (contract) {
    const door = new Set(contract.scopes ?? []);
    return { key: `contract ${contract.operationId}`, doors: door.size ? [door] : [], gates: [door, ...fileGates] };
  }
  if (!file) return { problem: 'no contract or pages/ route serves this path' };
  if (!offPages && !servesVerb(source, claim.method))
    return { problem: `${path.relative(CLIENT_DIR, file)} does not serve this method` };
  return { key: path.relative(CLIENT_DIR, file), doors: doorsIn(source), gates: fileGates };
}

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
      return parsed ? parsed.methods.map(method => ({ scope: value, endpoint, method, path: parsed.path })) : [];
    })
  );

const isOverlay = (p: string) => OVERLAY_PATH_PREFIXES.some(prefix => p.startsWith(prefix));
const CLAIMS = claimsOf([...USER_API_KEY_SCOPES, ...ADMIN_ONLY_API_KEY_SCOPES]);
const CHECKED = CLAIMS.filter(c => !isOverlay(c.path)).map(claim => ({ claim, route: routeOf(claim) }));

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
      if (OPEN_TO_ANY_KEY.has(`${claim.method} ${claim.path}`)) return;
      const problem =
        route.key === undefined
          ? route.problem
          : verifyGates(claim.scope, route.doors, route.gates, CLAIMANTS.get(claimantsKey(claim, route.key))!);
      expect(problem, `${claim.scope} claims "${claim.endpoint}"`).toBeUndefined();
    }
  );

  it.each([...OPEN_TO_ANY_KEY])('%s is still open to any key', endpoint => {
    const { methods, path: routePath } = parseEndpoint(endpoint)!;
    const contract = CONTRACTS.find(
      c => c.method.toUpperCase() === methods[0] && normalizePath(c.path) === normalizePath(routePath)
    );
    expect(contract?.scopes ?? [], `${endpoint} has a contract scope door`).toEqual([]);
    const file = resolvePageFile(routePath);
    expect(file, `${endpoint} has no pages/ route`).toBeDefined();
    const code = stripComments(readFileSync(file!, 'utf8'));
    expect(code, `${endpoint} now declares a route-level scope door`).not.toMatch(/\brequiredScopes\b/);
    expect(
      CLAIMS.some(c => `${c.method} ${c.path}` === endpoint),
      `${endpoint} is claimed by no scope`
    ).toBe(true);
  });

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
    expect(routeOf(claim)).toMatchObject({ problem: expect.stringMatching(/does not serve this method/) });
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
