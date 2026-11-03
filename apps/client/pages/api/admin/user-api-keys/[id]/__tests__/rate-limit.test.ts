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

// The real failure path (logEventSafe swallowing a thrown write) is covered by
// analytics-failure.test.ts, which leaves analyticsLog unmocked.
const logEventSafe = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEventSafe }));

const recordAdminActionFromRequest = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest }));

import '@pages/api/admin/user-api-keys/[id]/rate-limit';

const storedKey = { id: 'key-1', userId: 'owner-1', name: 'wedged key' };
const admin = { id: 'admin-1', username: 'admin', isAdmin: true };

function patch(query: Record<string, unknown>, body: unknown, user?: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'PATCH', query, body });
  if (user) (req as any).user = user;
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
    expect(logEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        metadata: expect.objectContaining({ updatedFields: ['rateLimit.requestsPerMinute'] }),
      }),
      expect.anything(),
      (req as any).logger,
      'API key key-1'
    );
  });

  it('records user.api_key.rate_limit_updated against the key with a before/after diff', async () => {
    findById.mockResolvedValue({ ...storedKey, rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 } });
    const { req, res } = patch({ id: 'key-1' }, { requestsPerMinute: 600 }, admin);
    await mockRefs.patchHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.api_key.rate_limit_updated',
        target: { kind: 'apiKey', id: 'key-1', displayName: 'wedged key' },
        changes: expect.arrayContaining([{ field: 'rateLimit.requestsPerMinute', before: 60, after: 600 }]),
        details: { ownerUserId: 'owner-1' },
      })
    );
  });

  it('still succeeds when the best-effort audit write itself fails', async () => {
    const { adminAuditService } = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
    const { req, res } = patch({ id: 'key-1' }, { requestsPerMinute: 600 }, admin);
    recordAdminActionFromRequest.mockImplementationOnce((_req: unknown, input: any) =>
      adminAuditService.recordAdminAction(
        { ...input, actor: { kind: 'user', scope: 'platform', userId: 'admin-1' }, context: {} },
        { db: { adminAuditLog: { append: vi.fn().mockRejectedValue(new Error('audit down')) } }, logger: req.logger }
      )
    );

    await mockRefs.patchHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(req.logger.error).toHaveBeenCalledWith(
      '[ADMIN_AUDIT_WRITE_FAILED]',
      expect.objectContaining({ action: 'user.api_key.rate_limit_updated' })
    );
  });

  it('records nothing when the key is not found', async () => {
    findById.mockResolvedValue(null);
    const { req, res } = patch({ id: 'key-1' }, { requestsPerMinute: 600 }, admin);
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow();

    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('registers PATCH only, so next-connect 405s every other verb', () => {
    expect(mockRefs.patchHandler).not.toBeNull();
    expect(mockRefs.otherVerbs).toEqual([]);
  });
});
