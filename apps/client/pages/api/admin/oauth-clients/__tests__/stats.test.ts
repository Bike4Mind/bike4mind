import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { handlers, configs, db } = vi.hoisted(() => ({
  configs: [] as unknown[],
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  db: { getOAuthClientUsageStats: vi.fn() },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    configs.push(config);
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain: Record<string, unknown> = {
      use: (middleware: (req: unknown, res: unknown, next: () => void) => void) => {
        middlewares.push(middleware);
        return chain;
      },
    };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        handlers[method] = async (req: unknown, res: unknown) => {
          for (const middleware of middlewares) middleware(req, res, () => undefined);
          return fn(req, res);
        };
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => db);

import '@pages/api/admin/oauth-clients/stats';

const stats = {
  b4m_my_app_0011aabb: { signups7d: 2, signups30d: 5, activeUsers7d: 3, activeUsers30d: 9 },
};

function makeReqRes(user: unknown = { isAdmin: true, id: 'admin-1', username: 'root' }) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as { user?: unknown }).user = user;
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getOAuthClientUsageStats.mockResolvedValue(stats);
});

describe('/api/admin/oauth-clients/stats', () => {
  it('requires the admin API-key scope', () => {
    expect(configs).toEqual([expect.objectContaining({ requiredScopes: [ApiKeyScope.ADMIN] })]);
  });

  it('rejects an admin without support:read and an ordinary user', async () => {
    for (const user of [
      { isAdmin: false, id: 'd1', adminPermissions: ['settings:manage'] },
      { isAdmin: false, id: 'u1' },
    ]) {
      const { req, res } = makeReqRes(user);
      await expect(handlers.get(req, res)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(db.getOAuthClientUsageStats).not.toHaveBeenCalled();
  });

  it('returns the usage stats to a delegated support:read admin', async () => {
    const { req, res } = makeReqRes({ isAdmin: false, id: 'd2', adminPermissions: ['support:read'] });
    await handlers.get(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(stats);
    expect(db.getOAuthClientUsageStats).toHaveBeenCalledTimes(1);
  });
});
