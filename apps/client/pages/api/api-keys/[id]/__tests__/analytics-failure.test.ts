import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * delete and set-active commit their change before the analytics write, so a
 * failed write must not surface as a 5xx for a change that already landed.
 * analyticsLog is deliberately left unmocked - the real logEventSafe runs and the
 * counter write underneath it is what throws.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      delete: (fn: any) => {
        mockRefs.deleteHandler = fn;
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
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const storedKey = () => ({ id: 'k1', apiKey: 'ciphertext', type: 'openai', isActive: true });
const deleteApiKey = vi.hoisted(() => vi.fn());
const setApiKey = vi.hoisted(() => vi.fn());
const incrementUserCounter = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { deleteApiKey, setApiKey },
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

import '@pages/api/api-keys/[id]/delete';
import '@pages/api/api-keys/[id]/set-active';

function request(method: 'DELETE' | 'POST') {
  const { req, res } = createMocks({ method, query: { id: 'k1' }, body: { type: 'openai' } });
  (req as any).user = { id: 'u1' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('api-keys/[id] writes - failed analytics write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteApiKey.mockResolvedValue(storedKey());
    setApiKey.mockResolvedValue(storedKey());
  });

  it('DELETE still answers 200 when the counter write throws', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const { req, res } = request('DELETE');

    await expect(mockRefs.deleteHandler!(req, res)).resolves.not.toThrow();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ id: 'k1', type: 'openai', isActive: true });
    expect(deleteApiKey).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).toHaveBeenCalledWith(expect.stringMatching(/analytics/i), expect.any(Error));
  });

  it('set-active still answers 200 when the counter write throws', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const { req, res } = request('POST');

    await expect(mockRefs.postHandler!(req, res)).resolves.not.toThrow();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ id: 'k1', type: 'openai', isActive: true });
    expect(setApiKey).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).toHaveBeenCalledWith(expect.stringMatching(/analytics/i), expect.any(Error));
  });

  it('both answer 200 on the happy path without logging an error', async () => {
    for (const [method, handler] of [
      ['DELETE', mockRefs.deleteHandler],
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
