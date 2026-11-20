import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * index: an admin read of user subscriptions, gated on support:read or credits:adjust
 * (CREDITS_PAGE_READ). The real adminApi guard runs; only the data layer is mocked.
 */

type Handler = (req: { method?: string }, res: unknown, next: () => void) => unknown;
type Invocable = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({ getHandler: null as null | Invocable, postHandler: null as null | Invocable }));

// The chain runs adminApi's real permission guard (and any other use() middleware) ahead of the handler.
vi.mock('@server/middlewares/baseApi', () => {
  const guards: Handler[] = [];
  const gated = (method: string, fn: Invocable) => async (req: { method?: string }, res: unknown) => {
    req.method = method;
    for (const guard of guards) guard(req, res, () => {});
    return fn(req, res);
  };
  const chain = {
    use: (fn: Handler) => {
      guards.push(fn);
      return chain;
    },
    get: (fn: Invocable) => {
      mockRefs.getHandler = gated('GET', fn);
      return chain;
    },
    post: (fn: Invocable) => {
      mockRefs.postHandler = gated('POST', fn);
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const repo = vi.hoisted(() => ({
  findWithOwnerDetails: vi.fn().mockResolvedValue({ items: [] }),
  getSubscriptionStats: vi.fn().mockResolvedValue({ total: 0 }),
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({ subscriptionRepository: repo }));

import '@pages/api/subscriptions/index';

const REFUSAL = 'Missing permission: support:read or credits:adjust';
const dataLayer = repo.findWithOwnerDetails;

function call(user: { id: string; isAdmin: boolean; adminPermissions?: string[] }) {
  const { req, res } = createMocks({ method: 'GET', query: {} });
  (req as unknown as { user: unknown }).user = user;
  return { result: mockRefs.getHandler!(req, res), res };
}

describe('GET /api/subscriptions/index - admin permission gate', () => {
  beforeEach(() => dataLayer.mockClear());

  it('refuses a signed-in non-admin before touching the data layer', async () => {
    await expect(call({ id: 'u1', isAdmin: false }).result).rejects.toThrow(REFUSAL);
    expect(dataLayer).not.toHaveBeenCalled();
  });

  it.each(['credits:adjust', 'support:read'])('admits a delegate holding only %s', async permission => {
    const { result, res } = call({ id: 'u2', isAdmin: false, adminPermissions: [permission] });
    await result;
    expect(dataLayer).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it('refuses a delegate holding an unrelated permission', async () => {
    await expect(call({ id: 'u3', isAdmin: false, adminPermissions: ['users:moderate'] }).result).rejects.toThrow(
      REFUSAL
    );
    expect(dataLayer).not.toHaveBeenCalled();
  });

  it('admits a full admin', async () => {
    const { result, res } = call({ id: 'admin1', isAdmin: true });
    await result;
    expect(dataLayer).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });
});
