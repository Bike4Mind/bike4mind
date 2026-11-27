import { describe, it, expect, vi } from 'vitest';
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

vi.mock('@bike4mind/database', () => ({
  CounterLog: {},
  cacheRepository: {},
}));

const h = vi.hoisted(() => ({ getCachedData: vi.fn() }));

vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: h.getCachedData },
}));

import handler from '../event-metrics';

describe('GET /api/admin/event-metrics', () => {
  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: ApiKeyScope[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('never returns prompt text an older event row or cached response still holds', async () => {
    h.getCachedData.mockResolvedValue([
      { id: '1', eventName: 'Prompt Heard', metadata: { sessionId: 's1', promptMessage: 'private prompt text' } },
    ]);
    const res = { json: vi.fn(), status: vi.fn() };

    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(
      { method: 'GET', query: {}, logger: { error: vi.fn() } },
      res
    );

    expect(res.json).toHaveBeenCalledWith([{ id: '1', eventName: 'Prompt Heard', metadata: { sessionId: 's1' } }]);
  });
});
