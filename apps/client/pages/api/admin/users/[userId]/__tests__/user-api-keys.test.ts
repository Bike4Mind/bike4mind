import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockUserFind, mockListKeys, mockGetUsage, mockCountRequests, mockDescribeAccess } = vi.hoisted(() => ({
  mockUserFind: vi.fn(),
  mockListKeys: vi.fn(),
  mockGetUsage: vi.fn(),
  mockCountRequests: vi.fn(),
  mockDescribeAccess: vi.fn(),
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

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
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
  apiKeyUsageLogRepository: { countRequestsByKeyWindows: (...a: unknown[]) => mockCountRequests(...a) },
}));

vi.mock('@server/utils/apiKeyAccessGate', () => ({
  describeApiKeyAccess: (...a: unknown[]) => mockDescribeAccess(...a),
}));

vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { listUserApiKeys: (...a: unknown[]) => mockListKeys(...a) },
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  getApiKeyRateLimitUsage: (...a: unknown[]) => mockGetUsage(...a),
}));

import handler from '../user-api-keys';
// These resolve to the mocked classes above, so instanceof pins which error
// (and therefore which status) each guard maps to.
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

const ADMIN = { id: 'admin1', isAdmin: true };
const ACCESS = { mode: 'paid', allowed: false, basis: 'no_paid_subscription' };

const run = ({ user, userId = 'u1' }: { user?: unknown; userId?: string | string[] } = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

// Stands in for a hydrated document: the handler reads keys through toJSON.
const hydrate = <T extends Record<string, unknown>>(fields: T) => ({ ...fields, toJSON: () => fields });

beforeEach(() => {
  mockUserFind.mockReset();
  mockListKeys.mockReset();
  mockGetUsage.mockReset().mockResolvedValue({ minute: 0, day: 0 });
  mockCountRequests.mockReset().mockResolvedValue({});
  mockDescribeAccess.mockReset().mockResolvedValue(ACCESS);
});

describe('GET /api/admin/users/:userId/user-api-keys', () => {
  it('rejects non-admins with ForbiddenError before touching any data source', async () => {
    const { promise } = run({ user: { id: 'u2', isAdmin: false } });
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockListKeys).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (no req.user) with ForbiddenError', async () => {
    const { promise } = run();
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockListKeys).not.toHaveBeenCalled();
  });

  it('rejects a userId that arrives as an array', async () => {
    const { promise } = run({ user: ADMIN, userId: ['a', 'b'] });
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('rejects an empty-string userId', async () => {
    const { promise } = run({ user: ADMIN, userId: '' });
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('404s when the target user does not exist, without listing keys', async () => {
    mockUserFind.mockResolvedValue(null);
    const { promise } = run({ user: ADMIN });
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(mockListKeys).not.toHaveBeenCalled();
  });

  it('returns an empty list (200, not 404) for a user with no keys', async () => {
    mockUserFind.mockResolvedValue({ id: 'u1' });
    mockListKeys.mockResolvedValue([]);
    const { res, promise } = run({ user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ apiKeys: [], liveUsage: {}, requests: {}, access: ACCESS });
    expect(mockGetUsage).not.toHaveBeenCalled();
  });

  it('lists all statuses (includeDisabled) and maps live usage per key id', async () => {
    const keys = [
      { id: 'k1', name: 'wedged', status: 'active' },
      { id: 'k2', name: 'old', status: 'disabled' },
    ];
    mockUserFind.mockResolvedValue({ id: 'u1' });
    mockListKeys.mockResolvedValue(keys.map(hydrate));
    mockGetUsage.mockResolvedValueOnce({ minute: 60, day: 300 }).mockResolvedValueOnce({ minute: 0, day: 0 });
    mockCountRequests.mockResolvedValue({ k1: { last24h: 4, last7d: 9 } });

    const { res, promise } = run({ user: ADMIN });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Listed fields pass through unchanged; the secret fields are the schema's job to withhold
    // (see the strip tests below).
    expect(res._getJSONData()).toEqual({
      apiKeys: keys,
      liveUsage: { k1: { minute: 60, day: 300 }, k2: { minute: 0, day: 0 } },
      requests: { k1: { last24h: 4, last7d: 9 } },
      access: ACCESS,
    });
    expect(mockCountRequests).toHaveBeenCalledExactlyOnceWith('u1', expect.any(Date));
    expect(mockDescribeAccess).toHaveBeenCalledExactlyOnceWith({ id: 'u1' });
    expect(mockListKeys).toHaveBeenCalledWith(
      'u1',
      { db: { userApiKeys: { __marker: 'userApiKeyRepository' } } },
      { includeDisabled: true }
    );
    expect(mockGetUsage).toHaveBeenCalledWith('k1');
    expect(mockGetUsage).toHaveBeenCalledWith('k2');
  });
  it('strips the secret and undeclared fields from a key', async () => {
    const leaky = {
      id: 'k1',
      name: 'wedged',
      status: 'active',
      keyHash: '$2b$bcrypt',
      keyDigest: 'sha256hex',
      callbackSigningSecret: 'enc:secret',
      somethingUndeclared: 'x',
    };
    mockUserFind.mockResolvedValue({ id: 'u1' });
    mockListKeys.mockResolvedValue([hydrate(leaky)]);

    const { res, promise } = run({ user: ADMIN });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().apiKeys).toEqual([{ id: 'k1', name: 'wedged', status: 'active' }]);
  });

  it('serializes hydrated documents through toJSON before the schema runs', async () => {
    const hydrated = { id: 'k1', toJSON: () => ({ id: 'k1', name: 'from-toJSON', keyHash: '$2b$bcrypt' }) };
    mockUserFind.mockResolvedValue({ id: 'u1' });
    mockListKeys.mockResolvedValue([hydrated]);

    const { res, promise } = run({ user: ADMIN });
    await promise;

    expect(res._getJSONData().apiKeys).toEqual([{ id: 'k1', name: 'from-toJSON' }]);
  });
});
