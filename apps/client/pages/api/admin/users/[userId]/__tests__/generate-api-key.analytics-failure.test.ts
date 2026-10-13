import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The key is minted before the analytics write, so a failed write must not turn
 * the mint into a 5xx: the admin would retry and mint a second live key. The
 * sibling generate-api-key.test.ts mocks analyticsLog; this one leaves it unmocked
 * so the real logEventSafe runs and the counter write underneath throws.
 */

const mockRefs = vi.hoisted(() => ({ postHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
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

vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  organizationRepository: {},
  userRepository: { findById: vi.fn().mockResolvedValue({ id: 'target-user', username: 'target' }) },
  mongoose: {},
  Ability: class {},
  User: {},
  UserActivityCounter: {},
  CounterLog: {},
}));

const createUserApiKey = vi.hoisted(() => vi.fn());
const incrementUserCounter = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { createUserApiKey },
  dataLakeService: {},
  counterService: { incrementUserCounter },
}));

import '@pages/api/admin/users/[userId]/generate-api-key';

function post() {
  const { req, res } = createMocks({
    method: 'POST',
    query: { userId: 'target-user' },
    body: { name: 'service key', scopes: ['notebooks:read'] },
  });
  (req as any).user = { id: 'admin-1', username: 'admin', isAdmin: true };
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/admin/users/[userId]/generate-api-key - failed analytics write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createUserApiKey.mockResolvedValue({ id: 'k1', name: 'service key', scopes: ['notebooks:read'] });
  });

  it('still answers 201 with the minted key when the counter write throws', async () => {
    incrementUserCounter.mockRejectedValueOnce(new Error('counter write failed'));
    const { req, res } = post();

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual(expect.objectContaining({ id: 'k1' }));
    expect(createUserApiKey).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/analytics.*API key k1/),
      expect.any(Error)
    );
  });

  it('answers 201 on the happy path without logging an error', async () => {
    const { req, res } = post();
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(incrementUserCounter).toHaveBeenCalledTimes(1);
    expect((req as any).logger.error).not.toHaveBeenCalled();
  });
});
