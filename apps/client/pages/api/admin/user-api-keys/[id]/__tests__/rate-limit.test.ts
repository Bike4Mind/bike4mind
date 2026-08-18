import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Admin rate-limit update route contract: the admin guard short-circuits before
 * any repo call, the id param is validated before the lookup, a missing key
 * 404s before the write, and the update runs against the *owner's* id so the
 * service's ownership lookup resolves. Bounds live in the service
 * (userApiKeyService/rateLimit.test.ts).
 */

const mockRefs = vi.hoisted(() => ({
  patchHandler: null as null | ((req: any, res: any) => unknown),
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
    post: verb('post'),
    put: verb('put'),
    delete: verb('delete'),
    patch: (fn: any) => {
      mockRefs.patchHandler = fn;
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

const updateApiKeyRateLimit = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    id: 'key-1',
    name: 'wedged key',
    rateLimit: { requestsPerMinute: 600, requestsPerDay: 1000 },
  })
);
vi.mock('@bike4mind/services', () => ({ userApiKeyService: { updateApiKeyRateLimit } }));

const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

import '@pages/api/admin/user-api-keys/[id]/rate-limit';

const storedKey = { id: 'key-1', userId: 'owner-1', name: 'wedged key' };
const admin = { id: 'admin-1', username: 'admin', isAdmin: true };

function patch(query: Record<string, unknown>, body: unknown, user?: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'PATCH', query, body });
  if (user) (req as any).user = user;
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

describe('PATCH /api/admin/user-api-keys/[id]/rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockResolvedValue(storedKey);
    updateApiKeyRateLimit.mockResolvedValue({
      id: 'key-1',
      name: 'wedged key',
      rateLimit: { requestsPerMinute: 600, requestsPerDay: 1000 },
    });
  });

  it('rejects a non-admin before touching any data source', async () => {
    const { req, res } = patch({ id: 'key-1' }, { requestsPerMinute: 600 }, { id: 'u1', isAdmin: false });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(findById).not.toHaveBeenCalled();
    expect(updateApiKeyRateLimit).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (no req.user) the same way', async () => {
    const { req, res } = patch({ id: 'key-1' }, { requestsPerMinute: 600 });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(findById).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['empty string', { id: '' }],
    ['array', { id: ['a', 'b'] }],
  ])('rejects an invalid id param (%s) before the repo lookup', async (_label, query) => {
    const { req, res } = patch(query, { requestsPerMinute: 600 }, admin);
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/invalid api key id/i);
    expect(findById).not.toHaveBeenCalled();
  });

  it('404s an unknown key and never calls the service', async () => {
    findById.mockResolvedValue(null);
    const { req, res } = patch({ id: 'ghost' }, { requestsPerMinute: 600 }, admin);
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/not found/i);
    expect(updateApiKeyRateLimit).not.toHaveBeenCalled();
  });

  it('updates against the key owner, not the acting admin', async () => {
    const { req, res } = patch({ id: 'key-1' }, { requestsPerMinute: 600 }, admin);
    await mockRefs.patchHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      id: 'key-1',
      name: 'wedged key',
      rateLimit: { requestsPerMinute: 600, requestsPerDay: 1000 },
    });
    expect(updateApiKeyRateLimit).toHaveBeenCalledWith(
      'owner-1',
      { keyId: 'key-1', requestsPerMinute: 600, requestsPerDay: undefined },
      expect.anything()
    );
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        metadata: expect.objectContaining({ updatedFields: ['rateLimit.requestsPerMinute'] }),
      }),
      expect.anything()
    );
  });

  it('still succeeds when the audit event write fails (orphaned-key owner)', async () => {
    logEvent.mockRejectedValueOnce(new Error('User not found'));
    const { req, res } = patch({ id: 'key-1' }, { requestsPerDay: 5000 }, admin);
    await mockRefs.patchHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect((req as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('key-1'));
  });

  it('registers PATCH only, so next-connect 405s every other verb', () => {
    expect(mockRefs.patchHandler).not.toBeNull();
    expect(mockRefs.otherVerbs).toEqual([]);
  });
});
