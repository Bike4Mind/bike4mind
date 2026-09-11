import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The regression this family was written for: the key change commits, then the
 * analytics write fails. Deliberately does NOT mock @server/utils/analyticsLog -
 * the real logEventSafe runs, and the counter write underneath it is what throws,
 * so this exercises the guard through the route rather than around it.
 *
 * Revoke stands in for the family (they share the shape); the wrapper's own
 * contract is covered in server/utils/analyticsLog.test.ts.
 */

const mockRefs = vi.hoisted(() => ({ postHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: () => chain,
    patch: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const revokeUserApiKey = vi.hoisted(() => vi.fn().mockResolvedValue({ name: 'CLI key' }));
const incrementUserCounter = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { revokeUserApiKey },
  counterService: { incrementUserCounter },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  mongoose: {},
  Ability: class {},
  User: {},
  UserActivityCounter: {},
  CounterLog: {},
}));

import '@pages/api/user-api-keys/[id]/revoke';

function post() {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'key-1' }, body: { reason: 'leaked' } });
  (req as any).user = { id: 'u1', isAdmin: false };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/user-api-keys/[id]/revoke - failed analytics write', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still answers 200 when the counter write throws, and records the failure', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const { req, res } = post();

    await expect(mockRefs.postHandler!(req, res)).resolves.not.toThrow();

    // A 5xx here reads as retryable, but the key is already revoked - the retry
    // would come back 404 on a revoke that actually succeeded.
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ success: true });
    expect(revokeUserApiKey).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).toHaveBeenCalledWith(expect.stringMatching(/analytics/i), expect.any(Error));
  });

  it('answers 200 on the happy path with the counter write attempted', async () => {
    const { req, res } = post();
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(incrementUserCounter).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).not.toHaveBeenCalled();
  });
});
