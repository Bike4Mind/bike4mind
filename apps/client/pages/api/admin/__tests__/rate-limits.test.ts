import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind } = vi.hoisted(() => ({ mockFind: vi.fn() }))

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (middleware: (typeof middlewares)[number]) => (middlewares.push(middleware), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  RateLimitSnapshot: {
    find: (...a: unknown[]) => {
      mockFind(...a);
      const q = { sort: () => q, limit: () => q, lean: () => Promise.resolve([]) };
      return q;
    },
  },
}));

import handler from '../rate-limits';

const run = (user: unknown) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => mockFind.mockReset());

describe('GET /api/admin/rate-limits', () => {
  it.each(['support:read', 'users:moderate'])('lets a delegate holding %s read', async permission => {
    const { res, promise } = run({ id: 'u1', isAdmin: false, adminPermissions: [permission] });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockFind).toHaveBeenCalled();
  });

  it('rejects a delegate holding only keys:revoke', async () => {
    const { promise } = run({ id: 'u1', isAdmin: false, adminPermissions: ['keys:revoke'] });
    await expect(promise).rejects.toThrow(/missing permission/i);
    expect(mockFind).not.toHaveBeenCalled();
  });
});
