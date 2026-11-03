/**
 * Reads which API-key scopes each route in this repo enforces, from the routes' own source. Shared by
 * the claims check (app/constants/apiKeyScopeEndpoints.test.ts: every endpoint a scope lists must
 * really be gated on it) and the generator (app/constants/apiKeyScopeEndpoints.generated.test.ts:
 * every route a scope opens is listed under it).
 *
 * Node-only and test-only: it walks pages/ with node:fs and imports the server scope modules. A caller
 * must `vi.mock('@bike4mind/services')` and `vi.mock('@server/auth/turnAuth')`, so the data-lake
 * scope module does not load the services graph for a few gate lists.
 *
 * A gate is the set of scopes one check admits (any-of). In-handler checks are attributed per verb
 * where the file chains its handlers (`.get(..).post(..)`): a check inside one verb's link counts for
 * that verb only. Anything outside the links (the door, a local function a link calls) counts for
 * every verb, and a file with no links (a `req.method` branch) is read whole.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ApiKeyScope, CONTRACTS, isBuiltInApiKeyScope } from '@bike4mind/common';
import * as agentScopes from '@server/agents/agentScopes';
import * as dataLakeScopes from '@server/dataLakes/dataLakeScopes';
import * as fileScopes from '@server/files/fileScopes';
import * as projectScopes from '@server/projects/projectScopes';

export const CLIENT_DIR = path.resolve(__dirname, '..');
export const PAGES_DIR = path.join(CLIENT_DIR, 'pages');

// Routes this repo serves outside pages/ (CloudFront sends them to the chat-completion container;
// see infra/chatCompletion.ts), keyed by `METHOD /path`, valued by the source file that handles them.
export const OFF_PAGES_ROUTES: Record<string, string> = {
  'POST /api/embed/chat': 'server/chatCompletion/external/embedRoute.ts',
};

// Routes served by premium overlays, which are not checked out here: their entries cannot be derived
// or verified in this repo, so a catalogue row lists them by hand.
export const OVERLAY_PATH_PREFIXES = [
  '/api/premium-overwatch/',
  '/api/overwatch/marketing-reports',
  '/api/premium-bob/',
];

export const isOverlayPath = (p: string) => OVERLAY_PATH_PREFIXES.some(prefix => p.startsWith(prefix));

// Files whose exported functions are scope-check helpers a route may call instead of naming a list.
const HELPER_SOURCES = [
  'server/agents/agentScopes.ts',
  'server/dataLakes/dataLakeScopes.ts',
  'server/files/fileScopes.ts',
  'server/projects/projectScopes.ts',
  'server/cli/auth.ts',
];

// Helpers that check scopes by hand (`.includes` + throw) rather than through an enforcing site, so
// they cannot be derived; each is pinned in the claims test to throw and to name exactly these scopes.
export const HAND_HELPERS: Record<string, { file: string; scopes: readonly ApiKeyScope[] }> = {
  assertHearthWriteScope: { file: 'server/utils/hearthWire.ts', scopes: [ApiKeyScope.HEARTH_WRITE, ApiKeyScope.ADMIN] },
};

export type Gate = ReadonlySet<ApiKeyScope>;

const SCOPE_BY_MEMBER = new Map<string, ApiKeyScope>(Object.entries(ApiKeyScope));
const SCOPE_VALUES = new Set<string>(Object.values(ApiKeyScope));

export const scopeOf = (member: string) => SCOPE_BY_MEMBER.get(member);

// Exported gate lists a route can pass to baseApi or assertApiKeyScope, by export name. A route
// gated through a list from a module not imported here goes unread, so add the module.
export const SCOPE_MODULES = [agentScopes, dataLakeScopes, fileScopes, projectScopes];
export const GATE_LISTS = new Map<string, readonly ApiKeyScope[]>(
  SCOPE_MODULES.flatMap(m => Object.entries(m)).filter(
    (entry): entry is [string, ApiKeyScope[]] =>
      Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(v => SCOPE_VALUES.has(v))
  )
);

// Also drops imports and `required_scopes: ...` 403 payloads: they name a gate, they do not enforce
// one. The line-comment pass also cuts a `//` inside a regex or mid-string, which can only drop a
// gate, never invent one.
export const stripComments = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/^import\b[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')
    .replace(/required_scopes:\s*(\[[^[\]]*\]|[A-Z_]+)/g, '');

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
export function gatesIn(code: string, helpers: ReadonlyMap<string, Gate>): Gate[] {
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
export function doorsIn(code: string): Gate[] {
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

export const HELPERS = loadHelpers();

export const normalizePath = (p: string) => p.replace(/\{[^}]+\}|:[A-Za-z_]+/g, ':param');

/** Parses `GET /api/x/:id` or `PATCH|DELETE /api/x/:id`, ignoring a trailing `(qualifier)`; undefined for prose entries. */
export function parseEndpoint(endpoint: string): { methods: string[]; path: string } | undefined {
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
export function verbSource(source: string, method: string): string {
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
export function servesVerb(source: string, method: string): boolean {
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
export function resolvePageFile(routePath: string): string | undefined {
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

/** How one method on one route is gated: a contract door (one method) or one source file read for that method. */
export type RouteGates = { key: string; doors: Gate[]; gates: Gate[] } | { key?: undefined; problem: string };

export function gatesForRoute(method: string, routePath: string): RouteGates {
  const contract = CONTRACTS.find(
    c => c.method.toUpperCase() === method && normalizePath(c.path) === normalizePath(routePath)
  );
  const offPages = OFF_PAGES_ROUTES[`${method} ${routePath}`];
  const file = offPages ? path.join(CLIENT_DIR, offPages) : resolvePageFile(routePath);
  const source = file ? stripComments(readFileSync(file, 'utf8')) : '';
  const fileGates = file ? gatesIn(offPages ? source : verbSource(source, method), HELPERS) : [];
  // A contract's scopes are the door; the handler behind it may add an enforcing check of its own,
  // which counts too. (A `holdsApiKeyScope` probe plus a hand-thrown 403 does not.)
  if (contract) {
    // A contract may name a contributed scope; this repo models only the built-in ones.
    const door: Gate = new Set((contract.scopes ?? []).filter(isBuiltInApiKeyScope));
    return { key: `contract ${contract.operationId}`, doors: door.size ? [door] : [], gates: [door, ...fileGates] };
  }
  if (!file) return { problem: 'no contract or pages/ route serves this path' };
  if (!offPages && !servesVerb(source, method))
    return { problem: `${path.relative(CLIENT_DIR, file)} does not serve this method` };
  return { key: path.relative(CLIENT_DIR, file), doors: offPages ? [] : doorsIn(source), gates: fileGates };
}

export const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** The `/api/...` path a pages/ file serves, with `[param]` segments as `:param`; undefined for a catch-all. */
export function routePathOf(file: string): string | undefined {
  const rel = path.relative(PAGES_DIR, file).replace(/\.tsx?$/, '');
  const segments = rel.split(path.sep);
  if (segments.at(-1) === 'index') segments.pop();
  if (segments.some(s => s.startsWith('[...') || s.startsWith('[[...'))) return undefined;
  return '/' + segments.map(s => s.replace(/^\[(\w+)\]$/, ':$1')).join('/');
}

/** Every route file under pages/api (tests and catch-alls excluded). */
export function pageRouteFiles(dir = path.join(PAGES_DIR, 'api')): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : pageRouteFiles(full);
    return /\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Every `METHOD /path` this repo serves: contracts, pages/ routes by the verbs they serve, and off-pages routes. */
export function listRoutes(): { method: string; path: string }[] {
  const routes = new Map<string, { method: string; path: string }>();
  for (const c of CONTRACTS) {
    const p = c.path.replace(/\{(\w+)\}/g, ':$1');
    routes.set(`${c.method.toUpperCase()} ${normalizePath(p)}`, { method: c.method.toUpperCase(), path: p });
  }
  for (const file of pageRouteFiles()) {
    const routePath = routePathOf(file);
    if (!routePath) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const method of VERBS) {
      const key = `${method} ${normalizePath(routePath)}`;
      if (!routes.has(key) && servesVerb(source, method)) routes.set(key, { method, path: routePath });
    }
  }
  for (const endpoint of Object.keys(OFF_PAGES_ROUTES)) {
    const { methods, path: p } = parseEndpoint(endpoint)!;
    routes.set(`${methods[0]} ${normalizePath(p)}`, { method: methods[0], path: p });
  }
  return [...routes.values()];
}

const intersects = (a: Gate, b: Gate) => [...a].some(s => b.has(s));
const sameGate = (a: Gate, b: Gate) => a.size === b.size && [...a].every(s => b.has(s));

/**
 * The scopes, among `candidates`, a key holding only that scope gets through on this route. With a
 * door: the door must admit it, and so must every in-handler check that narrows the door (shares a
 * scope with it). A check sharing none is an extra condition on some requests (createFabFile's
 * lake-tag write check), not a narrowing, so it does not bar the door's scopes. With no door: every
 * check must admit it, and a route with no check at all opens to every key, so no scope opens it.
 */
export function scopesOpening(route: RouteGates, candidates: readonly ApiKeyScope[]): ApiKeyScope[] {
  if (route.key === undefined) return [];
  const { doors, gates } = route;
  if (doors.length > 0) {
    const doorScopes = new Set(doors.flatMap(d => [...d]));
    const narrowing = gates.filter(g => !doors.some(d => sameGate(d, g)) && intersects(g, doorScopes));
    return candidates.filter(s => doors.some(d => d.has(s)) && narrowing.every(g => g.has(s)));
  }
  if (gates.length === 0) return [];
  return candidates.filter(s => gates.every(g => g.has(s)));
}

const VERB_ORDER = new Map<string, number>(VERBS.map((v, i) => [v, i]));

/**
 * For each of `scopes`, every core route a key holding only that scope gets through, as catalogue
 * entries (`GET|PUT /api/x/:id`, one per path, sorted). Overlay paths are left to their rows.
 */
export function deriveScopeEndpoints(scopes: readonly ApiKeyScope[]): Map<ApiKeyScope, string[]> {
  const byScope = new Map<ApiKeyScope, Map<string, string[]>>(scopes.map(s => [s, new Map()]));
  for (const { method, path: routePath } of listRoutes()) {
    if (isOverlayPath(routePath)) continue;
    for (const scope of scopesOpening(gatesForRoute(method, routePath), scopes)) {
      const paths = byScope.get(scope)!;
      paths.set(routePath, [...(paths.get(routePath) ?? []), method]);
    }
  }
  return new Map(
    [...byScope].map(([scope, paths]) => [
      scope,
      [...paths]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([p, methods]) => `${methods.sort((a, b) => VERB_ORDER.get(a)! - VERB_ORDER.get(b)!).join('|')} ${p}`),
    ])
  );
}
