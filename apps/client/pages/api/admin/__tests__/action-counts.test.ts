import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockCompute } = vi.hoisted(() => ({ mockCompute: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/admin/actionCounts', () => ({ computeAdminActionCounts: mockCompute }));

import handler from '../action-counts';

const call = (user: unknown) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const configOf = () => (handler as unknown as { _config?: { auth?: unknown; requiredScopes?: string[] } })._config;

beforeEach(() => {
  mockCompute.mockReset().mockResolvedValue({ approvals: 2, deadLetters: null });
});

describe('GET /api/admin/action-counts', () => {
  it('refuses API keys: jwtOnly and no requiredScopes', () => {
    expect(configOf()?.auth).toBe('jwtOnly');
    expect(configOf()?.requiredScopes).toBeUndefined();
  });

  it('rejects a user without support:read with 403', async () => {
    await expect(
      call({ id: 'u2', isAdmin: false, adminPermissions: ['credits:adjust'] }).promise
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it('returns the counts for the caller, uncached', async () => {
    const user = { id: 'delegate', isAdmin: false, adminPermissions: ['support:read'] };
    const { res, promise } = call(user);
    await promise;

    expect(mockCompute).toHaveBeenCalledWith(user, 'delegate');
    expect(res._getJSONData()).toEqual({ counts: { approvals: 2, deadLetters: null } });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('uses the impersonating admin as the viewer user id', async () => {
    await call({ id: 'target', isAdmin: true, impersonatedBy: 'real-admin' }).promise;

    expect(mockCompute.mock.calls[0]?.[1]).toBe('real-admin');
  });
});
