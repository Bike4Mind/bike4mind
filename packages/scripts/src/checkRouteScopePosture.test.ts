import { describe, expect, it } from 'vitest';
import type { RouteAnalysis } from './apiRouteInventory';
import { analyzeApiRoutes, read } from './apiRouteSources';
import {
  classifyScopePosture,
  scopePostureFailures,
  UNCLASSIFIED_REASONS,
  type PostureRoute,
  type ScopeBaseline,
} from './routeScopePosture';
import { ROUTE_SCOPE_BASELINE } from './routeScopePostureBaseline';

// New routes go to reviewedUnscoped with a reason, never here, so this only ever goes down.
const LEGACY_UNSCOPED_LIMIT = 376;

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

  it('treats a contracted verb without scopes as unscoped', () => {
    const methodScopes = [
      { methods: ['GET' as const], scopes: ['a:read'] },
      { methods: ['POST' as const], scopes: [] },
    ];
    expect(classifyScopePosture(analysis({ scopes: ['a:read'], methodScopes, contracted: true }), '').kind).toBe(
      'unscoped'
    );
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
  const empty: ScopeBaseline = { legacyUnscoped: [], reviewedUnscoped: {}, unclassified: {} };
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
      scopePostureFailures(routes, { ...empty, legacyUnscoped: ['/api/a'], reviewedUnscoped: { '/api/b': 'x' } })
    ).toEqual([]);
  });

  it('fails stale entries: a removed route or one that gained a posture', () => {
    const failures = scopePostureFailures([route('/api/scoped', { kind: 'scoped' })], {
      ...empty,
      legacyUnscoped: ['/api/gone', '/api/scoped'],
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
});

describe('API-key scope posture of apps/client/pages/api', () => {
  const routes: PostureRoute[] = analyzeApiRoutes().map(entry => ({
    route: entry.route,
    file: entry.file,
    posture: classifyScopePosture(entry, read(entry.analyzedFile)),
  }));

  it('gives every key-accepting route a deliberate scope posture', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(scopePostureFailures(routes, ROUTE_SCOPE_BASELINE)).toEqual([]);
  });

  it('does not grow the legacy list', () => {
    expect(ROUTE_SCOPE_BASELINE.legacyUnscoped.length).toBeLessThanOrEqual(LEGACY_UNSCOPED_LIMIT);
  });
});
