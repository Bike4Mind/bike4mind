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

// Real ObjectId strings: the route filters uncastable ids out of the $in, so
// placeholder names like 'passes' would be dropped and every row would read deny.
const PASSES = '507f1f77bcf86cd799439011';
const BREAKS = '507f1f77bcf86cd799439012';
const DELETED = '507f1f77bcf86cd799439013';
const GRANDFATHERED = '507f1f77bcf86cd799439014';

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
      { keyId: PASSES, userId: 'u1', requests: 5, lastUsed: new Date() },
      { keyId: BREAKS, userId: 'u2', requests: 99, lastUsed: new Date() },
    ]);
    find.mockResolvedValue([
      { id: PASSES, scopes: ['notebooks:read', 'admin:*'] },
      { id: BREAKS, scopes: ['notebooks:read'] },
    ]);

    const res = await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' });
    const body = res._getJSONData();

    // Sorted worst-first despite `passes` coming first out of the aggregation.
    expect(body.rows.map((r: any) => r.keyId)).toEqual([BREAKS, PASSES]);
    expect(body.rows[0].outcome).toBe('deny');
    expect(body.rows[1].outcome).toBe('allow');
    expect(body.rows[0].heldScopes).toEqual(['notebooks:read']);
  });

  it('reports a key that no longer exists as holding nothing', async () => {
    findKeyTrafficByEndpointPrefix.mockResolvedValue([
      { keyId: DELETED, userId: 'u1', requests: 3, lastUsed: new Date() },
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
      { keyId: GRANDFATHERED, userId: 'u1', requests: 7, lastUsed: new Date() },
    ]);
    find.mockResolvedValue([{ id: GRANDFATHERED, scopes: [] }]);

    const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'optihashi:read' }))._getJSONData();
    expect(body.rows[0].outcome).toBe('stagedAllow');
    expect(body.stagedScopes).toEqual(['optihashi:read']);
  });

  it('survives a log row whose keyId is not a valid ObjectId', async () => {
    // An unfiltered $in would raise a Mongoose CastError, which errorHandler
    // turns into a 404 - indistinguishable from "no data" to the operator.
    findKeyTrafficByEndpointPrefix.mockResolvedValue([
      { keyId: 'not-an-objectid', userId: 'u1', requests: 2, lastUsed: new Date() },
      { keyId: '507f1f77bcf86cd799439011', userId: 'u2', requests: 1, lastUsed: new Date() },
    ]);
    find.mockResolvedValue([{ id: '507f1f77bcf86cd799439011', scopes: ['admin:*'] }]);

    const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();

    // Only the castable id reaches the query, projected to the one field read.
    expect(find).toHaveBeenCalledWith({ _id: { $in: ['507f1f77bcf86cd799439011'] } }, { scopes: 1 });
    // ...and the malformed row is still reported rather than dropped.
    expect(body.rows).toHaveLength(2);
    expect(body.rows.find((r: any) => r.keyId === 'not-an-objectid').outcome).toBe('deny');
  });

  it('does not query at all when no keyId is castable', async () => {
    findKeyTrafficByEndpointPrefix.mockResolvedValue([
      { keyId: 'junk', userId: 'u1', requests: 1, lastUsed: new Date() },
    ]);

    const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();
    expect(find).not.toHaveBeenCalled();
    expect(body.rows[0].outcome).toBe('deny');
  });

  it('says so when no key has called the routes', async () => {
    const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();
    expect(body.rows).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  describe('coverage', () => {
    it('reports a default-window run over a logged prefix as fully covered', async () => {
      const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();
      expect(body.coverage).toEqual({ fullWindow: true, unloggedPrefixes: [] });
    });

    it('clears fullWindow below the TTL, so an empty result cannot read as conclusive', async () => {
      // A key that fires monthly leaves no trace in a 7-day window; an empty
      // result there is an absence of evidence, not a clean bill of health.
      const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*', days: '7' }))._getJSONData();
      expect(body.windowDays).toBe(7);
      expect(body.coverage.fullWindow).toBe(false);
    });

    it('refuses a prefix whose traffic is never logged rather than answering zero', async () => {
      // ApiKeyUsageLog is written only by baseApi's apiKeyAuth hook. These routes
      // authenticate through verifyApiKey and log nothing, so a "no keys" answer
      // here would be a false statement of fact - and verifyApiKey has no staging
      // path, so acting on it breaks live keys with no grace period.
      for (const prefix of ['/api/ai/v1', '/api/ai/v1/tools', '/api/embed/chat']) {
        await expect(invoke({ endpointPrefix: prefix, scopes: 'admin:*' })).rejects.toThrow(/verifyApiKey/);
      }
      expect(findKeyTrafficByEndpointPrefix).not.toHaveBeenCalled();
    });

    it('names the unlogged surfaces a broader prefix sweeps up, and still runs', async () => {
      const body = (await invoke({ endpointPrefix: '/api/', scopes: 'admin:*' }))._getJSONData();
      expect(body.coverage.unloggedPrefixes).toEqual(['/api/ai/v1', '/api/embed']);
      expect(findKeyTrafficByEndpointPrefix).toHaveBeenCalled();
    });

    it('does not flag a sibling prefix that merely shares a stem', async () => {
      const body = (await invoke({ endpointPrefix: '/api/notebooks', scopes: 'admin:*' }))._getJSONData();
      expect(body.coverage.unloggedPrefixes).toEqual([]);
    });
  });

  describe('truncation', () => {
    const traffic = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        keyId: `k${i}`,
        userId: 'u1',
        requests: 1,
        lastUsed: new Date(),
      }));

    it('does not report a complete list as partial at exactly the cap', async () => {
      // The route asks for MAX_ROWS + 1, so a full page with no overflow row is
      // known to be the whole population - `length === MAX_ROWS` alone could not
      // tell the two apart and would send the operator narrowing for no reason.
      findKeyTrafficByEndpointPrefix.mockResolvedValue(traffic(500));

      const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();
      expect(findKeyTrafficByEndpointPrefix).toHaveBeenCalledWith(expect.objectContaining({ limit: 501 }));
      expect(body.rows).toHaveLength(500);
      expect(body.truncated).toBe(false);
    });

    it('flags truncation and drops the overflow row when there is more', async () => {
      findKeyTrafficByEndpointPrefix.mockResolvedValue(traffic(501));

      const body = (await invoke({ endpointPrefix: '/api/x', scopes: 'admin:*' }))._getJSONData();
      expect(body.rows).toHaveLength(500);
      expect(body.truncated).toBe(true);
    });
  });
});
