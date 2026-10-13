import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The key is stored before the analytics write runs, so a failed write must not
 * turn the create into a 5xx: the client would retry and store a duplicate key.
 * analyticsLog is deliberately left unmocked - the real logEventSafe runs and the
 * counter write underneath it is what throws (same shape as
 * user-api-keys/[id]/__tests__/revoke.analytics-failure.test.ts).
 */

const mockRefs = vi.hoisted(() => ({ postHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const createApiKey = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'k1', description: 'mine', isActive: true, type: 'openai' })
);
const incrementUserCounter = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { createApiKeySchema: { parse: (body: unknown) => body }, createApiKey },
  counterService: { incrementUserCounter },
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  mongoose: {},
  Ability: class {},
  User: {},
  UserActivityCounter: {},
  CounterLog: {},
}));

import '@pages/api/api-keys/create';

function post() {
  const { req, res } = createMocks({ method: 'POST', body: { apiKey: 'sk-test', type: 'openai' } });
  (req as any).user = { id: 'u1' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/api-keys/create - failed analytics write', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still answers 200 with the stored key when the counter write throws', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const { req, res } = post();

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(expect.objectContaining({ id: 'k1' }));
    expect(createApiKey).toHaveBeenCalledTimes(1);
    expect(incrementUserCounter).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).toHaveBeenCalledWith(expect.stringMatching(/analytics/i), expect.any(Error));
  });

  it('answers 200 on the happy path without logging an error', async () => {
    const { req, res } = post();
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(incrementUserCounter).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).not.toHaveBeenCalled();
  });
});
