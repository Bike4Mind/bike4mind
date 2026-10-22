// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  audit: vi.fn(),
  runProbe: vi.fn(),
  runAllProbes: vi.fn(),
  setOverride: vi.fn(),
  clearCache: vi.fn(),
  resetBreaker: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = { use: () => chain };
    for (const method of ['get', 'post', 'put']) {
      chain[method] = (fn: Handler) => {
        h.handlers[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/database', () => ({
  INTEGRATION_HEALTH_INTEGRATIONS: ['github', 'slack'],
  integrationHealthCheckRepository: {},
  integrationCircuitOverrideRepository: { setOverride: h.setOverride },
}));
vi.mock('@bike4mind/server-utils/services/integrationHealthService', () => ({
  getHealthSummary: vi.fn(),
  runProbe: h.runProbe,
  runAllProbes: h.runAllProbes,
}));
vi.mock('@bike4mind/server-utils/services/integrationCircuitBreaker', () => ({
  getStatus: vi.fn(),
  clearCache: h.clearCache,
}));
vi.mock('@bike4mind/server-utils/services/mcpCircuitBreakers', () => ({
  flushBreakerMetrics: h.flush,
  getAllBreakerStates: vi.fn(),
  resetBreaker: h.resetBreaker,
}));

await import('../integration-health');

const call = async (method: 'post' | 'put', body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'POST' | 'PUT', body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await h.handlers[method](req, res);
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
  h.flush.mockResolvedValue(undefined);
});

describe('integration-health admin audit', () => {
  it('records a single-integration probe', async () => {
    h.runProbe.mockResolvedValue(probeResult('github'));

    const { req } = await call('post', { integration: 'github' });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'system_health.integration_probe_run',
      target: { kind: 'system', id: 'integration-health' },
      details: { integration: 'github', status: 'healthy' },
    });
    expect(h.runProbe.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records a probe of all integrations', async () => {
    h.runAllProbes.mockResolvedValue([probeResult('github'), probeResult('slack')]);

    await call('post', {});

    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'system_health.integration_probe_run',
      details: {
        integrations: [
          { integration: 'github', status: 'healthy' },
          { integration: 'slack', status: 'healthy' },
        ],
      },
    });
  });

  it('records a circuit breaker override after it takes effect', async () => {
    h.setOverride.mockResolvedValue({ integration: 'slack', mode: 'force_block', setBy: 'admin-1', reason: 'outage' });

    const { res } = await call('put', { integration: 'slack', mode: 'force_block', reason: 'outage' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'system_health.integration_override_set',
      target: { kind: 'settings', id: 'slack' },
      details: { integration: 'slack', mode: 'force_block', overrideReason: 'outage' },
    });
    expect(h.clearCache.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit a rejected override', async () => {
    await expect(call('put', { integration: 'slack', mode: 'bogus' })).rejects.toThrow();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
