// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  get: undefined as Handler | undefined,
  getHealthSummary: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = { use: () => chain, post: () => chain };
    chain.get = (fn: Handler) => {
      h.get = fn;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/database', () => ({
  INTEGRATION_HEALTH_INTEGRATIONS: ['github', 'slack'],
  integrationHealthCheckRepository: { getRecentByIntegration: vi.fn().mockResolvedValue([]) },
  integrationAuditLogRepository: { findByDateRange: vi.fn().mockResolvedValue([]) },
  RateLimitSnapshot: {
    find: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
  },
}));
vi.mock('@bike4mind/server-utils/services/integrationHealthService', () => ({
  getHealthSummary: h.getHealthSummary,
  runProbe: vi.fn(),
  runAllProbes: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/services/integrationCircuitBreaker', () => ({
  getStatus: vi.fn().mockResolvedValue({ available: true, reason: null, mode: 'auto', autoTripped: false }),
}));
vi.mock('@bike4mind/server-utils/services/mcpCircuitBreakers', () => ({
  flushBreakerMetrics: vi.fn(),
  getAllBreakerStates: vi.fn().mockReturnValue({}),
}));

await import('../integration-health-dashboard');

const summary = (integration: string, lastCheckedAt: Date | null) => ({
  integration,
  status: 'unhealthy',
  latencyMs: 0,
  lastCheckedAt,
  successRate: 0,
  consecutiveFailures: 0,
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/integration-health-dashboard', () => {
  it('reports a never-checked integration with a null lastCheckedAt', async () => {
    h.getHealthSummary.mockResolvedValue([
      summary('github', new Date('2026-11-09T10:00:00.000Z')),
      summary('slack', null),
    ]);
    const { req, res } = createMocks({ method: 'GET', query: { timeRange: '24h' } });

    await h.get?.(req, res);

    const body = res._getJSONData() as { integrations: { name: string; lastCheckedAt: string | null }[] };
    expect(body.integrations).toEqual([
      expect.objectContaining({ name: 'github', lastCheckedAt: '2026-11-09T10:00:00.000Z' }),
      expect.objectContaining({ name: 'slack', lastCheckedAt: null }),
    ]);
  });
});
