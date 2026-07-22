import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockUserFind, mockListKeys, mockGetUsage } = vi.hoisted(() => ({
  mockUserFind: vi.fn(),
  mockListKeys: vi.fn(),
  mockGetUsage: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
}));

// The repository is only handed through as the service's db adapter, so an
// identity object is enough to pin the wiring.
vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: { __marker: 'userApiKeyRepository' },
}));

vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { listUserApiKeys: (...a: unknown[]) => mockListKeys(...a) },
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  getApiKeyRateLimitUsage: (...a: unknown[]) => mockGetUsage(...a),
}));

import handler from '../user-api-keys';

const ADMIN = { id: 'admin1', isAdmin: true };

const run = ({ user, userId = 'u1' }: { user?: unknown; userId?: string | string[] } = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockUserFind.mockReset();
  mockListKeys.mockReset();
  mockGetUsage.mockReset().mockResolvedValue({ minute: 0, day: 0 });
});

describe('GET /api/admin/users/:userId/user-api-keys', () => {
  it('rejects non-admins before touching any data source', async () => {
    const { promise } = run({ user: { id: 'u2', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockListKeys).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (no req.user)', async () => {
    const { promise } = run();
    await expect(promise).rejects.toThrow();
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockListKeys).not.toHaveBeenCalled();
  });

  it('rejects a userId that arrives as an array', async () => {
    const { promise } = run({ user: ADMIN, userId: ['a', 'b'] });
    await expect(promise).rejects.toThrow('Invalid user ID');
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('rejects an empty-string userId', async () => {
    const { promise } = run({ user: ADMIN, userId: '' });
    await expect(promise).rejects.toThrow('Invalid user ID');
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('404s when the target user does not exist, without listing keys', async () => {
    mockUserFind.mockResolvedValue(null);
    const { promise } = run({ user: ADMIN });
    await expect(promise).rejects.toThrow('User not found');
    expect(mockListKeys).not.toHaveBeenCalled();
  });

  it('returns an empty list (200, not 404) for a user with no keys', async () => {
    mockUserFind.mockResolvedValue({ id: 'u1' });
    mockListKeys.mockResolvedValue([]);
    const { res, promise } = run({ user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ apiKeys: [], liveUsage: {} });
    expect(mockGetUsage).not.toHaveBeenCalled();
  });

  it('lists all statuses (includeDisabled) and maps live usage per key id', async () => {
    const keys = [
      { id: 'k1', name: 'wedged', status: 'active' },
      { id: 'k2', name: 'old', status: 'disabled' },
    ];
    mockUserFind.mockResolvedValue({ id: 'u1' });
    mockListKeys.mockResolvedValue(keys);
    mockGetUsage.mockResolvedValueOnce({ minute: 60, day: 300 }).mockResolvedValueOnce({ minute: 0, day: 0 });

    const { res, promise } = run({ user: ADMIN });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // The body is a passthrough of what the service returned; keyHash
    // redaction is the model toJSON transform's job (pinned in
    // UserApiKeyModel.embed.test.ts), not this route's.
    expect(res._getJSONData()).toEqual({
      apiKeys: keys,
      liveUsage: { k1: { minute: 60, day: 300 }, k2: { minute: 0, day: 0 } },
    });
    expect(mockListKeys).toHaveBeenCalledWith(
      'u1',
      { db: { userApiKeys: { __marker: 'userApiKeyRepository' } } },
      { includeDisabled: true }
    );
    expect(mockGetUsage).toHaveBeenCalledWith('k1');
    expect(mockGetUsage).toHaveBeenCalledWith('k2');
  });
});
