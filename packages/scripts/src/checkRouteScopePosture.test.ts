import { beforeAll, describe, expect, it } from 'vitest';
import type { RouteAnalysis } from './apiRouteInventory';
import { analyzeApiRoutes, read } from './apiRouteSources';
import {
  classifyScopePosture,
  legacyDigest,
  scopePostureFailures,
  UNCLASSIFIED_REASONS,
  type PostureRoute,
  type ScopeBaseline,
} from './routeScopePosture';
import { ROUTE_SCOPE_BASELINE } from './routeScopePostureBaseline';

const analysis = (overrides: Partial<RouteAnalysis>): RouteAnalysis => ({
  methods: ['GET'],
  acceptsAnyMethod: false,
  auth: ['jwt+key'],
  scopes: [],
  contracted: false,
  ...overrides,
});

const ONE_ROUTER = 'export default baseApi().get(h);';

describe('classifyScopePosture', () => {
  it('reads each posture', () => {
    expect(classifyScopePosture(analysis({ scopes: ['admin:*'] }), ONE_ROUTER).kind).toBe('scoped');
    expect(classifyScopePosture(analysis({}), ONE_ROUTER).kind).toBe('unscoped');
    expect(classifyScopePosture(analysis({ auth: ['optional'] }), ONE_ROUTER).kind).toBe('unscoped');
    expect(classifyScopePosture(analysis({ auth: ['jwt'] }), ONE_ROUTER).kind).toBe('no-key');
    expect(classifyScopePosture(analysis({ auth: ['handler'] }), ONE_ROUTER).kind).toBe('no-key');
  });

  it('treats a direct apiKeyAuth() shim as key-accepting', () => {
    const shim = 'const keyShim = apiKeyAuth();\nexport default baseApi({ auth: false }).get(h);';
    expect(classifyScopePosture(analysis({ auth: ['handler'] }), shim).kind).toBe('unscoped');
    const importOnly = "import { apiKeyAuthFailure } from 'x'; // apiKeyAuth is not called here";
    expect(classifyScopePosture(analysis({ auth: ['handler'] }), importOnly).kind).toBe('no-key');
  });

  it('treats a contracted verb without scopes as unscoped', () => {
    const methodScopes = [
      { methods: ['GET' as const], scopes: ['a:read'] },
      { methods: ['POST' as const], scopes: [] },
    ];
    expect(classifyScopePosture(analysis({ scopes: ['a:read'], methodScopes, contracted: true }), '')).toEqual({
      kind: 'unscoped',
      verbs: ['POST'],
    });
  });

  it('does not credit baseApi scopes to optional or directly installed key shims', () => {
    const source = 'const shim = apiKeyAuth(); baseApi({ auth: false, requiredScopes: [S] });';
    for (const auth of [['optional'], ['handler']] as const) {
      expect(classifyScopePosture(analysis({ auth: [...auth], scopes: ['s'] }), source)).toEqual({
        kind: 'unscoped',
      });
    }
  });

  it('counts generic baseApi calls when checking for several routers', () => {
    for (const requestType of ['Request', 'Request & { callback: () => void }']) {
      const source = `baseApi<Request, Response>({ requiredScopes: [S] }); baseApi<${requestType}, Response>();`;
      expect(classifyScopePosture(analysis({ scopes: ['s'] }), source)).toEqual({
        kind: 'unclassified',
        reason: UNCLASSIFIED_REASONS.routerUnion,
      });
    }
  });

  it('does not count router examples in comments or strings', () => {
    const source = 'baseApi({ requiredScopes: [S] }); // baseApi()\nconst example = "baseApi()";';
    expect(classifyScopePosture(analysis({ scopes: ['s'] }), source)).toEqual({ kind: 'scoped' });
  });

  it('fails closed when the posture cannot be read', () => {
    expect(classifyScopePosture(analysis({ auth: ['unknown'] }), ONE_ROUTER)).toEqual({
      kind: 'unclassified',
      reason: UNCLASSIFIED_REASONS.dynamicAuth,
    });
    const twoRouters = `const a = baseApi({ requiredScopes: [S] }); const b = baseApi();`;
    expect(classifyScopePosture(analysis({ scopes: ['s'] }), twoRouters)).toEqual({
      kind: 'unclassified',
      reason: UNCLASSIFIED_REASONS.routerUnion,
    });
  });
});

describe('scopePostureFailures', () => {
  const empty: ScopeBaseline = { legacyUnscoped: [], legacySeed: new Set(), reviewedUnscoped: {}, unclassified: {} };
  const seeded = (...routes: string[]) => ({ legacyUnscoped: routes, legacySeed: new Set(routes.map(legacyDigest)) });
  const route = (name: string, posture: PostureRoute['posture']): PostureRoute => ({
    route: name,
    file: `apps/client/pages${name}.ts`,
    posture,
  });

  it('fails a new unscoped route and names every fix', () => {
    const [failure, ...rest] = scopePostureFailures([route('/api/new', { kind: 'unscoped' })], empty);
    expect(rest).toEqual([]);
    expect(failure).toContain('/api/new');
    expect(failure).toContain('requiredScopes');
    expect(failure).toContain("auth: 'jwtOnly'");
    expect(failure).toContain('reviewedUnscoped');
  });

  it('passes a listed route', () => {
    const routes = [route('/api/a', { kind: 'unscoped' }), route('/api/b', { kind: 'unscoped' })];
    expect(
      scopePostureFailures(routes, { ...empty, ...seeded('/api/a'), reviewedUnscoped: { '/api/b': 'x' } })
    ).toEqual([]);
  });

  it('names the verbs and the contract when only some verbs lack scopes', () => {
    const [failure] = scopePostureFailures([route('/api/c', { kind: 'unscoped', verbs: ['POST'] })], empty);
    expect(failure).toContain('on POST with no scopes');
    expect(failure).toContain('contract');
    expect(failure).toContain('jwtOnly operation');
  });

  it('rejects a route added to legacyUnscoped after it was seeded', () => {
    const routes = [route('/api/a', { kind: 'unscoped' }), route('/api/new', { kind: 'unscoped' })];
    const failures = scopePostureFailures(routes, {
      ...empty,
      legacyUnscoped: ['/api/a', '/api/new'],
      legacySeed: new Set([legacyDigest('/api/a')]),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('/api/new was added to legacyUnscoped');
    expect(failures[0]).toContain('requiredScopes');
    expect(failures[0]).toContain("auth: 'jwtOnly'");
    expect(failures[0]).toContain('reviewedUnscoped');
  });

  it('fails stale entries: a removed route or one that gained a posture', () => {
    const failures = scopePostureFailures([route('/api/scoped', { kind: 'scoped' })], {
      ...empty,
      ...seeded('/api/gone', '/api/scoped'),
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('/api/gone');
    expect(failures[1]).toContain('now scoped');
  });

  it('requires an unclassified entry to carry the current reason', () => {
    const unclassified = route('/api/u', { kind: 'unclassified', reason: UNCLASSIFIED_REASONS.dynamicAuth });
    expect(scopePostureFailures([unclassified], empty)).toHaveLength(1);
    expect(
      scopePostureFailures([unclassified], { ...empty, unclassified: { '/api/u': UNCLASSIFIED_REASONS.dynamicAuth } })
    ).toEqual([]);
  });

  it('requires seed digests to be pruned alongside removed legacy entries', () => {
    const failures = scopePostureFailures([], { ...empty, legacySeed: new Set([legacyDigest('/api/gone')]) });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('has no legacyUnscoped route');
    expect(scopePostureFailures([], empty)).toEqual([]);
  });
});

describe('API-key scope posture of apps/client/pages/api', () => {
  let routes: PostureRoute[] = [];
  beforeAll(() => {
    routes = analyzeApiRoutes().map(entry => ({
      route: entry.route,
      file: entry.file,
      posture: classifyScopePosture(entry, read(entry.analyzedFile)),
    }));
  });

  it('gives every key-accepting route a deliberate scope posture', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(scopePostureFailures(routes, ROUTE_SCOPE_BASELINE)).toEqual([]);
  });
});
