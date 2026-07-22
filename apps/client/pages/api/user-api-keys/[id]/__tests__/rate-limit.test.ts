import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * PATCH /api/user-api-keys/[id]/rate-limit: what the route forwards, what it
 * logs, and the id guard. The service is mocked - bounds and the ownership
 * lookup are the service's own contract, covered in
 * userApiKeyService/rateLimit.test.ts.
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

const updateApiKeyRateLimit = vi.hoisted(() =>
  vi.fn((_userId?: unknown, params?: Record<string, unknown>) => ({
    id: (params as any)?.keyId ?? 'key-1',
    name: 'CLI key',
    rateLimit: { requestsPerMinute: 600, requestsPerDay: 1000 },
  }))
);
vi.mock('@bike4mind/services', () => ({ userApiKeyService: { updateApiKeyRateLimit } }));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

import '@pages/api/user-api-keys/[id]/rate-limit';

function patch(id: string | undefined, body: unknown) {
  const { req, res } = createMocks({ method: 'PATCH', query: id === undefined ? {} : { id }, body });
  (req as any).user = { id: 'u1', isAdmin: false };
  return { req, res };
}

describe('PATCH /api/user-api-keys/[id]/rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the sent ceilings scoped to the caller and returns 200', async () => {
    const { req, res } = patch('key-1', { requestsPerMinute: 600 });
    await mockRefs.patchHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      id: 'key-1',
      name: 'CLI key',
      rateLimit: { requestsPerMinute: 600, requestsPerDay: 1000 },
    });
    // 'u1' is the caller, never a user id from the body - this is the
    // ownership scope the service enforces on.
    expect(updateApiKeyRateLimit).toHaveBeenCalledWith(
      'u1',
      { keyId: 'key-1', requestsPerMinute: 600, requestsPerDay: undefined },
      expect.anything()
    );
  });

  it('logs only the ceilings actually sent in updatedFields', async () => {
    const { req, res } = patch('key-1', { requestsPerDay: 5000 });
    await mockRefs.patchHandler!(req, res);

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ updatedFields: ['rateLimit.requestsPerDay'] }),
      }),
      expect.anything()
    );
  });

  it('rejects a missing key id with 400 and never calls the service', async () => {
    const { req, res } = patch(undefined, { requestsPerMinute: 600 });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/Invalid key ID/i);
    expect(updateApiKeyRateLimit).not.toHaveBeenCalled();
  });

  it('registers PATCH only, so next-connect 405s every other verb', () => {
    expect(mockRefs.patchHandler).not.toBeNull();
    expect(mockRefs.otherVerbs).toEqual([]);
  });
});
