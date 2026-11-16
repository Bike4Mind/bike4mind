import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/app-files is a cross-user file inventory with owner PII (populated
 * name/email) and no per-user scoping; its only consumer is the admin Files tab,
 * so it needs support:read. The real adminApi guard runs; only the query is mocked.
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

const find = vi.hoisted(() =>
  vi.fn(() => ({ populate: () => ({ sort: () => ({ exec: () => Promise.resolve([]) }) }) }))
);
vi.mock('@bike4mind/database/content', () => ({ AppFile: { find } }));

import '@pages/api/app-files/index';

const REFUSAL = 'Missing permission: support:read';

function call(user: { id: string; isAdmin: boolean; adminPermissions?: string[] }) {
  const { req, res } = createMocks({ method: 'GET', query: {} });
  (req as unknown as { user: unknown }).user = user;
  return { result: mockRefs.getHandler!(req, res), res };
}

describe('GET /api/app-files - admin permission gate', () => {
  beforeEach(() => find.mockClear());

  it('refuses a signed-in non-admin before querying', async () => {
    await expect(call({ id: 'u1', isAdmin: false }).result).rejects.toThrow(REFUSAL);
    expect(find).not.toHaveBeenCalled();
  });

  it('admits a delegate holding support:read', async () => {
    const { result, res } = call({ id: 'u2', isAdmin: false, adminPermissions: ['support:read'] });
    await result;
    expect(find).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it('refuses a delegate holding an unrelated permission', async () => {
    await expect(call({ id: 'u3', isAdmin: false, adminPermissions: ['users:moderate'] }).result).rejects.toThrow(
      REFUSAL
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('lists files for a full admin', async () => {
    const { result, res } = call({ id: 'admin1', isAdmin: true });
    await result;
    expect(find).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });
});
