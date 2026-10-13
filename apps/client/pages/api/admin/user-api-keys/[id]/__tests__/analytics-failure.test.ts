import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Both admin levers write before the analytics event, and the event write throws
 * for an orphaned key (owner doc deleted) - the case these levers exist for. The
 * sibling rate-limit/reset-rate-limit tests mock analyticsLog; this one leaves it
 * unmocked so the real logEventSafe runs and the counter write underneath throws.
 */

const mockRefs = vi.hoisted(() => ({
  patchHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      patch: (fn: any) => {
        mockRefs.patchHandler = fn;
        return chain;
      },
      post: (fn: any) => {
        mockRefs.postHandler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const storedKey = { id: 'key-1', userId: 'owner-1', name: 'wedged key' };
const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { findById } }));

const resetApiKeyRateLimit = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  resetApiKeyRateLimit,
  evaluateCounterLockout: vi.fn(),
  resolveCounterLimit: vi.fn(),
}));

const updateApiKeyRateLimit = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ id: 'key-1', name: 'wedged key', rateLimit: { requestsPerMinute: 60, requestsPerDay: 5000 } })
);
const incrementUserCounter = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: {
    updateApiKeyRateLimit,
    API_KEY_RATE_LIMIT_DEFAULTS: { requestsPerMinute: 60, requestsPerDay: 1000 },
  },
  counterService: { incrementUserCounter },
}));
vi.mock('@bike4mind/database', () => ({
  mongoose: {},
  Ability: class {},
  User: {},
  UserActivityCounter: {},
  CounterLog: {},
}));

import '@pages/api/admin/user-api-keys/[id]/rate-limit';
import '@pages/api/admin/user-api-keys/[id]/reset-rate-limit';

const admin = { id: 'admin-1', username: 'admin', isAdmin: true };

function request(method: 'PATCH' | 'POST') {
  const { req, res } = createMocks({ method, query: { id: 'key-1' }, body: { requestsPerDay: 5000 } });
  (req as any).user = admin;
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('admin user-api-keys/[id] levers - failed analytics write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockResolvedValue(storedKey);
  });

  it('PATCH rate-limit still answers 200 when the counter write throws', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('User not found'));
    const { req, res } = request('PATCH');

    await expect(mockRefs.patchHandler!(req, res)).resolves.not.toThrow();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(expect.objectContaining({ id: 'key-1' }));
    expect(updateApiKeyRateLimit).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).toHaveBeenCalledWith(expect.stringMatching(/analytics/i), expect.any(Error));
  });

  it('POST reset-rate-limit still answers 200 when the counter write throws', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('User not found'));
    const { req, res } = request('POST');

    await expect(mockRefs.postHandler!(req, res)).resolves.not.toThrow();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(expect.objectContaining({ success: true, id: 'key-1' }));
    expect(resetApiKeyRateLimit).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).toHaveBeenCalledWith(expect.stringMatching(/analytics/i), expect.any(Error));
  });

  it('both answer 200 on the happy path without logging an error', async () => {
    for (const [method, handler] of [
      ['PATCH', mockRefs.patchHandler],
      ['POST', mockRefs.postHandler],
    ] as const) {
      const { req, res } = request(method);
      await handler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect((req as any).logger.error).not.toHaveBeenCalled();
    }
    expect(incrementUserCounter).toHaveBeenCalledTimes(2);
  });
});
