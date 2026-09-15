import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

// Captures the config so a test can assert requiredScopes: the scope gate lives in
// apiKeyAuth (real middleware, not exercised here), so asserting the handler is
// registered with it is the only guard available at this level.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain._config = config;
    return chain;
  },
}));

const mockMarginByModelDay = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { marginByModelDay: (...a: unknown[]) => mockMarginByModelDay(...a) },
  userRepository: { findByIds: vi.fn().mockResolvedValue([]) },
}));

import handler from '../usage-margin';

function call(options: { isAdmin?: boolean; hasUser?: boolean; query?: object }) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? { view: 'model-day' } });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
      isAdmin: options.isAdmin ?? true,
      id: 'admin-1',
    };
  }
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/usage-margin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarginByModelDay.mockResolvedValue([]);
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    // Guards margin data against a narrowly-scoped key inheriting its owner's
    // isAdmin: apiKeyAuth rejects the key before req.user is set. JWT/browser
    // admins skip that check and are unaffected.
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockMarginByModelDay).not.toHaveBeenCalled();
  });

  it('returns model-day margin rows for an admin', async () => {
    mockMarginByModelDay.mockResolvedValue([{ model: 'opus', day: '2026-08-01', cogsUsd: 5, creditsCharged: 500 }]);
    const { res, run } = call({ query: { view: 'model-day', days: '14' } });
    await run();
    expect(res._getJSONData().rows).toHaveLength(1);
  });
});
