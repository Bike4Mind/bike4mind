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

const mockPlatformUsageSummary = vi.fn();
const mockPlatformEndpointUsage = vi.fn();
const mockUserApiKeyFind = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { platformUsageSummary: (...a: unknown[]) => mockPlatformUsageSummary(...a) },
  apiKeyUsageLogRepository: { platformEndpointUsage: (...a: unknown[]) => mockPlatformEndpointUsage(...a) },
  userApiKeyRepository: { find: (...a: unknown[]) => mockUserApiKeyFind(...a) },
}));

const mockOrgFind = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { find: (...a: unknown[]) => mockOrgFind(...a) },
}));

const mockResolveUserNames = vi.fn();
vi.mock('@server/utils/resolveUserNames', () => ({
  resolveUserNames: (...a: unknown[]) => mockResolveUserNames(...a),
}));

import handler from '../platform-usage';

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

describe('GET /api/admin/platform-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatformUsageSummary.mockResolvedValue({
      overTime: [],
      byFeature: [],
      byConsumer: [],
      byModel: [],
      totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
    });
    mockPlatformEndpointUsage.mockResolvedValue(null);
    mockUserApiKeyFind.mockResolvedValue([]);
    mockOrgFind.mockResolvedValue([]);
    mockResolveUserNames.mockResolvedValue(new Map());
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    // Guards platform usage against a narrowly-scoped key inheriting its owner's
    // isAdmin: apiKeyAuth rejects the key before req.user is set. JWT/browser
    // admins skip that check and are unaffected.
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects an unauthenticated request', async () => {
    const { run } = call({ hasUser: false });
    await expect(run()).rejects.toThrow();
    expect(mockPlatformUsageSummary).not.toHaveBeenCalled();
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockPlatformUsageSummary).not.toHaveBeenCalled();
  });

  it('returns the platform usage summary for an admin', async () => {
    const { res, run } = call({ query: { days: '7' } });
    await run();
    expect(mockPlatformUsageSummary).toHaveBeenCalledWith({ days: 7, source: undefined, ownerType: undefined });
    expect(res._getJSONData().days).toBe(7);
  });
});
