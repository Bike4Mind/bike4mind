import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Admin reset-rate-limit route contract: the admin guard short-circuits before
 * any repo call, the id param is validated before the lookup, a missing key
 * 404s before the reset, and a success clears the counters and writes the
 * audit event. The reset primitive itself (atomicity, per-counter failure
 * isolation) is covered by server/utils/apiKeyRateLimitCheck.test.ts and
 * apiKeyRateLimitReset.e2e.test.ts - only `resetApiKeyRateLimit` is mocked
 * here; `evaluateCounterLockout`, `resolveCounterLimit`, and
 * `MANAGEMENT_RATE_LIMIT` run for real so this route's ceiling-resolution
 * wiring is actually exercised, not just its mock call shape.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  otherVerbs: [] as string[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  const verb = (name: string) => () => {
    mockRefs.otherVerbs.push(name);
    return chain;
  };
  const chain: any = {
    use: () => chain,
    get: verb('get'),
    put: verb('put'),
    patch: verb('patch'),
    delete: verb('delete'),
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { findById } }));

const resetApiKeyRateLimit = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/apiKeyRateLimitCheck', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/apiKeyRateLimitCheck')>();
  return { ...actual, resetApiKeyRateLimit };
});

// Sources the real default from the actual package rather than a hardcoded literal, so a change
// to API_KEY_RATE_LIMIT_DEFAULTS shows up here instead of this fallback test silently staying
// green against a stale value.
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { userApiKeyService: { API_KEY_RATE_LIMIT_DEFAULTS: actual.userApiKeyService.API_KEY_RATE_LIMIT_DEFAULTS } };
});

const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

import '@pages/api/admin/user-api-keys/[id]/reset-rate-limit';

const storedKey = {
  id: 'key-1',
  userId: 'owner-1',
  name: 'wedged key',
  rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
};

function post(query: Record<string, unknown>, user?: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', query });
  if (user) (req as any).user = user;
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

const admin = { id: 'admin-1', username: 'admin', isAdmin: true };

describe('POST /api/admin/user-api-keys/[id]/reset-rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockResolvedValue(storedKey);
    resetApiKeyRateLimit.mockResolvedValue({
      request: { minute: 0, day: 0 },
      management: { minute: 0, day: 0 },
    });
  });

  it('rejects a non-admin before touching any data source', async () => {
    const { req, res } = post({ id: 'key-1' }, { id: 'u1', isAdmin: false });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(findById).not.toHaveBeenCalled();
    expect(resetApiKeyRateLimit).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (no req.user) the same way', async () => {
    const { req, res } = post({ id: 'key-1' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(findById).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['empty string', { id: '' }],
    ['array', { id: ['a', 'b'] }],
  ])('rejects an invalid id param (%s) before the repo lookup', async (_label, query) => {
    const { req, res } = post(query, admin);
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/invalid api key id/i);
    expect(findById).not.toHaveBeenCalled();
  });

  it('404s an unknown key and never calls the reset', async () => {
    findById.mockResolvedValue(null);
    const { req, res } = post({ id: 'ghost' }, admin);
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/not found/i);
    expect(resetApiKeyRateLimit).not.toHaveBeenCalled();
  });

  it('resets the resolved key id and writes the audit event on success', async () => {
    const { req, res } = post({ id: 'key-1' }, admin);
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      success: true,
      id: 'key-1',
      lockout: {
        request: { minuteAtLimit: false, dayAtLimit: false },
        management: { minuteAtLimit: false, dayAtLimit: false },
      },
    });
    // The stored doc id (what the enforcer keys on), not the raw param. Admin
    // resets also clear the management counter - it's the only override for
    // a client that has locked itself out of the self-service PATCH (#2883).
    // The route's own logger is threaded through so a clear failure logs with
    // request correlation instead of landing in bare console.warn.
    expect(resetApiKeyRateLimit).toHaveBeenCalledWith(storedKey.id, {
      alsoResetManagement: true,
      logger: (req as any).logger,
    });
    expect(logEvent).toHaveBeenCalledWith(
      {
        userId: 'owner-1',
        type: 'User API Key Rate Limit Reset',
        metadata: { keyId: 'key-1', name: 'wedged key', resetBy: 'admin-1' },
      },
      { ability: (req as any).ability }
    );
  });

  it("derives lockout against the right ceiling for each counter - the key's own limit for request, the fixed limit for management", async () => {
    resetApiKeyRateLimit.mockResolvedValue({
      request: { minute: 60, day: 40 }, // at the key's own 60/min ceiling
      management: { minute: 5, day: 12 }, // at the fixed 5/min management ceiling
    });

    const { req, res } = post({ id: 'key-1' }, admin);
    await mockRefs.postHandler!(req, res);

    expect(res._getJSONData().lockout).toEqual({
      request: { minuteAtLimit: true, dayAtLimit: false },
      management: { minuteAtLimit: true, dayAtLimit: false },
    });
  });

  it("omits a counter's lockout entry when resetApiKeyRateLimit could not clear it, without failing the request", async () => {
    // resetApiKeyRateLimit itself isolates per-counter failures - both the whole-counter and
    // single-window cases (see apiKeyRateLimitCheck.test.ts) - and reports either the same way:
    // `request` undefined. This route only needs to pass that through without treating a
    // missing counter as an error, so one test at this layer covers both underlying cases.
    resetApiKeyRateLimit.mockResolvedValue({
      request: undefined,
      management: { minute: 1, day: 2 },
    });

    const { req, res } = post({ id: 'key-1' }, admin);
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const lockout = res._getJSONData().lockout;
    expect(lockout).toEqual({
      request: undefined,
      management: { minuteAtLimit: false, dayAtLimit: false },
    });
    // `toEqual` treats a missing key and an `undefined` value the same, so it
    // alone doesn't prove `request` is actually absent from the JSON body -
    // assert the serialized key set directly.
    expect(Object.keys(lockout)).toEqual(['management']);
  });

  it('falls back to the default rate limit when the stored key has none, for lockout purposes only', async () => {
    findById.mockResolvedValue({ ...storedKey, rateLimit: undefined });
    resetApiKeyRateLimit.mockResolvedValue({
      request: { minute: 60, day: 0 }, // at the 60/min default
      management: { minute: 0, day: 0 },
    });

    const { req, res } = post({ id: 'key-1' }, admin);
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().lockout.request).toEqual({ minuteAtLimit: true, dayAtLimit: false });
  });

  it('still succeeds when the audit event write fails (orphaned-key owner)', async () => {
    // logEvent throws NotFoundError when the key owner's user doc is gone -
    // the reset already happened, so the request must not fail after the fact.
    logEvent.mockRejectedValueOnce(new Error('User not found'));
    const { req, res } = post({ id: 'key-1' }, admin);
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(resetApiKeyRateLimit).toHaveBeenCalledWith(storedKey.id, {
      alsoResetManagement: true,
      logger: (req as any).logger,
    });
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('key-1'));
  });

  it('surfaces a total reset failure to asyncHandler instead of answering a hollow 200 success', async () => {
    // resetApiKeyRateLimit itself now rejects when every counter fails to clear (see
    // apiKeyRateLimitCheck.test.ts). This handler runs with asyncHandler mocked to identity (see
    // the top-of-file mock), so the real 500-mapping isn't under test here - what matters is that
    // this route lets the rejection propagate instead of catching it and answering
    // { success: true } anyway.
    resetApiKeyRateLimit.mockRejectedValueOnce(new Error('Failed to clear any rate-limit counters'));
    const { req, res } = post({ id: 'key-1' }, admin);

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/failed to clear any rate-limit counters/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('registers POST only, so next-connect 405s every other verb', () => {
    expect(mockRefs.postHandler).not.toBeNull();
    expect(mockRefs.otherVerbs).toEqual([]);
  });
});
