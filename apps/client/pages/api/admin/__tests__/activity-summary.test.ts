import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';

const { getActivitySummary, route } = vi.hoisted(() => ({
  getActivitySummary: vi.fn(),
  route: {
    config: undefined as unknown,
    get: undefined as ((req: unknown, res: unknown) => Promise<unknown>) | undefined,
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    route.config = config;
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = {
      use: (middleware: (req: unknown, res: unknown, next: () => void) => unknown) => {
        middlewares.push(middleware);
        return chain;
      },
      get: (handler: NonNullable<typeof route.get>) => {
        route.get = async (req, res) => {
          for (const middleware of middlewares) await middleware(req, res, () => undefined);
          return handler(req, res);
        };
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/admin/getActivitySummary', () => ({ getActivitySummary }));

import '../activity-summary';

describe('GET /api/admin/activity-summary', () => {
  beforeEach(() => getActivitySummary.mockReset());

  it('requires the admin API scope', () => {
    expect(route.config).toEqual({ requiredScopes: [ApiKeyScope.ADMIN], allowedMethods: ['GET'] });
  });

  it('rejects non-admin users before querying activity', async () => {
    await expect(route.get?.({ method: 'GET', user: { isAdmin: false } }, {})).rejects.toThrow(/missing permission/i);
    expect(getActivitySummary).not.toHaveBeenCalled();
  });

  it('returns the summary and does not turn a query failure into an empty result', async () => {
    const summary = { totalEvents: 1003 };
    const json = vi.fn();
    getActivitySummary.mockResolvedValueOnce(summary);
    await route.get?.({ method: 'GET', user: { isAdmin: true } }, { json });
    expect(json).toHaveBeenCalledExactlyOnceWith(summary);

    getActivitySummary.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(route.get?.({ method: 'GET', user: { isAdmin: true } }, { json })).rejects.toThrow(
      'database unavailable'
    );
    expect(json).toHaveBeenCalledOnce();
  });
});
