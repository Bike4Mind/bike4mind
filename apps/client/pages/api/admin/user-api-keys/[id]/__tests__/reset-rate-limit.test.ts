import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Admin reset-rate-limit route contract: the admin guard short-circuits before
 * any repo call, the id param is validated before the lookup, a missing key
 * 404s before the reset, and a success clears the counters and writes the
 * audit event. The reset primitive itself is covered by
 * server/utils/apiKeyRateLimitCheck.test.ts and apiKeyRateLimitReset.e2e.test.ts.
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

const resetApiKeyRateLimit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({ resetApiKeyRateLimit }));

const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

import '@pages/api/admin/user-api-keys/[id]/reset-rate-limit';

const storedKey = { id: 'key-1', userId: 'owner-1', name: 'wedged key' };

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
    expect(res._getJSONData()).toEqual({ success: true, id: 'key-1' });
    // The stored doc id (what the enforcer keys on), not the raw param.
    expect(resetApiKeyRateLimit).toHaveBeenCalledWith(storedKey.id);
    expect(logEvent).toHaveBeenCalledWith(
      {
        userId: 'owner-1',
        type: 'User API Key Rate Limit Reset',
        metadata: { keyId: 'key-1', name: 'wedged key', resetBy: 'admin-1' },
      },
      { ability: (req as any).ability }
    );
  });

  it('still succeeds when the audit event write fails (orphaned-key owner)', async () => {
    // logEvent throws NotFoundError when the key owner's user doc is gone -
    // the reset already happened, so the request must not fail after the fact.
    logEvent.mockRejectedValueOnce(new Error('User not found'));
    const { req, res } = post({ id: 'key-1' }, admin);
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(resetApiKeyRateLimit).toHaveBeenCalledWith(storedKey.id);
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('key-1'));
  });

  it('registers POST only, so next-connect 405s every other verb', () => {
    expect(mockRefs.postHandler).not.toBeNull();
    expect(mockRefs.otherVerbs).toEqual([]);
  });
});
