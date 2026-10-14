import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  recordCheck: vi.fn(),
  createSnapshot: vi.fn(),
  fetch: vi.fn(),
}));

// Only what the probes may touch: no user, MCP server or workspace repository is exported, so a
// probe that went looking for a tenant's credential would fail here.
vi.mock('@bike4mind/database', () => ({
  integrationHealthCheckRepository: { recordCheck: h.recordCheck },
  rateLimitSnapshotRepository: { create: h.createSnapshot },
  INTEGRATION_HEALTH_INTEGRATIONS: ['slack', 'github', 'jira', 'confluence'],
  INTEGRATION_HEALTH_THRESHOLDS: { LATENCY_WARNING_MS: 2_000, LATENCY_CRITICAL_MS: 5_000 },
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitMetrics: vi.fn().mockResolvedValue(undefined),
  recordCircuitBreakerTransition: vi.fn().mockResolvedValue(undefined),
}));

import { runAllProbes, runProbe } from './integrationHealthService';
import { getAllBreakerStates } from './mcpCircuitBreakers';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

function respondWith(status: number): void {
  h.fetch.mockResolvedValue(new Response(null, { status }));
}

describe('integrationHealthService probes', () => {
  beforeEach(() => {
    h.recordCheck.mockReset().mockImplementation(async (check: unknown) => check);
    h.createSnapshot.mockReset();
    h.fetch.mockReset();
    vi.stubGlobal('fetch', h.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes every integration without sending any credential', async () => {
    respondWith(200);

    await runAllProbes(logger);

    expect(h.fetch).toHaveBeenCalledTimes(4);
    for (const [, init] of h.fetch.mock.calls) {
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.has('authorization')).toBe(false);
    }
  });

  it.each([401, 403, 404, 429])('treats HTTP %d as reachable, since the provider answered', async status => {
    respondWith(status);

    const check = await runProbe('github');

    expect(check).toMatchObject({ integration: 'github', status: 'healthy', statusCode: status, error: null });
  });

  it('marks a 5xx response unhealthy', async () => {
    respondWith(503);

    const check = await runProbe('jira');

    expect(check).toMatchObject({ integration: 'jira', status: 'unhealthy', statusCode: 503, error: 'HTTP 503' });
  });

  it('marks a network failure unhealthy', async () => {
    h.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const check = await runProbe('confluence');

    expect(check).toMatchObject({ integration: 'confluence', status: 'unhealthy', error: 'ECONNREFUSED' });
  });

  it('never feeds probe results into per-tenant breakers or rate-limit snapshots', async () => {
    h.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await runAllProbes(logger);

    expect(getAllBreakerStates()).toEqual({});
    expect(h.createSnapshot).not.toHaveBeenCalled();
  });
});
