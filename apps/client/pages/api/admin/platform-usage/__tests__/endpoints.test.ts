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

const mockPlatformEndpointUsage = vi.fn();
vi.mock('@bike4mind/database', () => ({
  apiKeyUsageLogRepository: { platformEndpointUsage: (...a: unknown[]) => mockPlatformEndpointUsage(...a) },
}));

import handler from '../endpoints';

function call(options: { isAdmin?: boolean; hasUser?: boolean; query?: object }) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? {} });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
      isAdmin: options.isAdmin ?? true,
      id: 'admin-1',
    };
  }
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/platform-usage/endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatformEndpointUsage.mockResolvedValue({ byEndpoint: [], overTime: [] });
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects an unauthenticated request', async () => {
    const { run } = call({ hasUser: false });
    await expect(run()).rejects.toThrow();
    expect(mockPlatformEndpointUsage).not.toHaveBeenCalled();
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockPlatformEndpointUsage).not.toHaveBeenCalled();
  });

  it('spans every source over the full 90-day window by default', async () => {
    const { res, run } = call({});
    await run();
    expect(mockPlatformEndpointUsage).toHaveBeenCalledWith({ days: 90, source: undefined });
    expect(res._getJSONData()).toMatchObject({ windowDays: 90, endpoints: { byEndpoint: [], overTime: [] } });
  });

  it.each(['api', 'cli'] as const)('passes source %s to the rollup and echoes it', async source => {
    const { res, run } = call({ query: { source } });
    await run();
    expect(mockPlatformEndpointUsage).toHaveBeenCalledWith({ days: 90, source });
    expect(res._getJSONData().source).toBe(source);
  });

  it('ignores a days param so the window cannot be narrowed by the page-wide filter', async () => {
    const { run } = call({ query: { days: '7' } });
    await run();
    expect(mockPlatformEndpointUsage).toHaveBeenCalledWith({ days: 90, source: undefined });
  });

  it('rejects a source the API-key log never records', async () => {
    const { run } = call({ query: { source: 'web' } });
    await expect(run()).rejects.toThrow();
    expect(mockPlatformEndpointUsage).not.toHaveBeenCalled();
  });
});
