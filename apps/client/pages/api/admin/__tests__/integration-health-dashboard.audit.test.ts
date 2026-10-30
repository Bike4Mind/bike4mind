// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  post: undefined as Handler | undefined,
  audit: vi.fn(),
  runProbe: vi.fn(),
  runAllProbes: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = { use: () => chain, get: () => chain };
    chain.post = (fn: Handler) => {
      h.post = fn;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/database', () => ({
  INTEGRATION_HEALTH_INTEGRATIONS: ['github', 'slack'],
  integrationHealthCheckRepository: {},
  integrationAuditLogRepository: {},
  RateLimitSnapshot: {},
}));
vi.mock('@bike4mind/server-utils/services/integrationHealthService', () => ({
  getHealthSummary: vi.fn(),
  runProbe: h.runProbe,
  runAllProbes: h.runAllProbes,
}));
vi.mock('@bike4mind/server-utils/services/integrationCircuitBreaker', () => ({ getStatus: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/mcpCircuitBreakers', () => ({
  flushBreakerMetrics: vi.fn(),
  getAllBreakerStates: vi.fn(),
}));

await import('../integration-health-dashboard');

const call = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await h.post?.(req, res);
  return { req, res };
};

const probeResult = (integration: string) => ({
  integration,
  status: 'healthy',
  latencyMs: 12,
  statusCode: 200,
  checkedAt: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/integration-health-dashboard admin audit', () => {
  it('records a single-integration probe', async () => {
    h.runProbe.mockResolvedValue(probeResult('github'));

    const { req } = await call({ integration: 'github' });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'system_health.integration_probe_run',
      target: { kind: 'system', id: 'integration-health' },
      details: { integration: 'github' },
    });
  });

  it('records a probe of all integrations', async () => {
    h.runAllProbes.mockResolvedValue([probeResult('github'), probeResult('slack')]);

    await call({});

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({ action: 'system_health.integration_probe_run' });
  });
});
