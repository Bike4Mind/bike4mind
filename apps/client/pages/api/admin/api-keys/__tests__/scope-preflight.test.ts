import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Scope-preflight route contract. The load-bearing behaviour is the verdict per
 * key, and this suite deliberately does NOT mock apiKeyScopeGate: the whole
 * point of the route is that it asks the same `decideScopeGate` the runtime gate
 * asks, so a test that stubbed it would prove nothing about the thing that
 * matters (a preflight that drifts from enforcement reports a confidently wrong
 * re-mint list).
 *
 * The baseApi mock records the config it was called with. A mock that discards
 * it - the common shape elsewhere in this repo - would let the admin-scope
 * declaration silently disappear while this file still passed.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  config: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: () => chain,
    put: () => chain,
    delete: () => chain,
    patch: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (config?: Record<string, unknown>) => {
      mockRefs.config = config;
      return chain;
    },
  };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const findKeyTrafficByEndpointPrefix = vi.hoisted(() => vi.fn());
const find = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/auth', () => ({
  apiKeyUsageLogRepository: { findKeyTrafficByEndpointPrefix },
  userApiKeyRepository: { find },
}));

import '../scope-preflight';

const invoke = async (query: Record<string, unknown>, user: unknown = { isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { query, user });
  await mockRefs.getHandler!(req, res);
  return res;
};

describe('GET /api/admin/api-keys/scope-preflight', () => {
  const ORIGINAL_STAGING = process.env.API_KEY_SCOPE_STAGING;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_KEY_SCOPE_STAGING;
    findKeyTrafficByEndpointPrefix.mockResolvedValue([]);
    find.mockResolvedValue([]);
  });

  afterEach(() => {
    if (ORIGINAL_STAGING === undefined) delete process.env.API_KEY_SCOPE_STAGING;
    else process.env.API_KEY_SCOPE_STAGING = ORIGINAL_STAGING;
  });

  it('declares the admin scope on the route itself', () => {
    expect(mockRefs.config?.requiredScopes).toEqual(['admin:*']);
  });

  it('refuses a non-admin before touching the usage log', async () => {
    await expect(invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }, { isAdmin: false })).rejects.toThrow(
      /Admin access required/
    );
    expect(findKeyTrafficByEndpointPrefix).not.toHaveBeenCalled();
  });

  it('rejects a prefix that is missing or not rooted at /', async () => {
    await expect(invoke({ scopes: 'admin:*' })).rejects.toThrow(/endpointPrefix/);
    await expect(invoke({ endpointPrefix: 'api/x', scopes: 'admin:*' })).rejects.toThrow(/endpointPrefix/);
  });

  it('rejects an unknown scope rather than dropping it', async () => {
    // Dropping it would narrow the required set and under-report who breaks,
    // producing a false "nobody is affected".
    await expect(invoke({ endpointPrefix: '/api/x', scopes: 'notascope:read' })).rejects.toThrow(/Unknown scope/);
    await expect(invoke({ endpointPrefix: '/api/x', scopes: '' })).rejects.toThrow(/scopes is required/);
  });

  it('clamps the window to the usage log TTL', async () => {
    await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*', days: '365' });
    expect(findKeyTrafficByEndpointPrefix).toHaveBeenCalledWith(expect.objectContaining({ days: 90 }));
  });

  it('classifies each key by the real gate and puts the breakage first', async () => {
    findKeyTrafficByEndpointPrefix.mockResolvedValue([
      { keyId: 'passes', userId: 'u1', requests: 5, lastUsed: new Date(), endpoints: ['/api/x/a'] },
      { keyId: 'breaks', userId: 'u2', requests: 99, lastUsed: new Date(), endpoints: ['/api/x/b'] },
    ]);
    find.mockResolvedValue([
      { id: 'passes', scopes: ['notebooks:read', 'admin:*'] },
      { id: 'breaks', scopes: ['notebooks:read'] },
    ]);

    const res = await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' });
    const body = res._getJSONData();

    // Sorted worst-first despite `passes` coming first out of the aggregation.
    expect(body.rows.map((r: any) => r.keyId)).toEqual(['breaks', 'passes']);
    expect(body.rows[0].outcome).toBe('deny');
    expect(body.rows[1].outcome).toBe('allow');
    expect(body.rows[0].heldScopes).toEqual(['notebooks:read']);
  });

  it('reports a key that no longer exists as holding nothing', async () => {
    findKeyTrafficByEndpointPrefix.mockResolvedValue([
      { keyId: 'deleted', userId: 'u1', requests: 3, lastUsed: new Date(), endpoints: ['/api/x/a'] },
    ]);
    find.mockResolvedValue([]);

    const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].outcome).toBe('deny');
    expect(body.rows[0].heldScopes).toEqual([]);
  });

  it('marks a key as surviving only on staging when the scope is staged', async () => {
    process.env.API_KEY_SCOPE_STAGING = 'optihashi:read';
    findKeyTrafficByEndpointPrefix.mockResolvedValue([
      { keyId: 'grandfathered', userId: 'u1', requests: 7, lastUsed: new Date(), endpoints: ['/api/x/a'] },
    ]);
    find.mockResolvedValue([{ id: 'grandfathered', scopes: [] }]);

    const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'optihashi:read' }))._getJSONData();
    expect(body.rows[0].outcome).toBe('stagedAllow');
    expect(body.stagedScopes).toEqual(['optihashi:read']);
  });

  it('says so when no key has called the routes', async () => {
    const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();
    expect(body.rows).toEqual([]);
    expect(body.truncated).toBe(false);
  });
});
