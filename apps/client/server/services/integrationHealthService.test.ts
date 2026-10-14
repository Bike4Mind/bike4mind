import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  recordCheck: vi.fn(),
  fetch: vi.fn(),
}));

// Only what the probes may touch: no user, MCP server or workspace repository is exported, so a
// probe that went looking for a tenant's credential would fail here.
vi.mock('@bike4mind/database', () => ({
  integrationHealthCheckRepository: { recordCheck: h.recordCheck },
  INTEGRATION_HEALTH_INTEGRATIONS: ['slack', 'github', 'jira', 'confluence'],
  INTEGRATION_HEALTH_THRESHOLDS: { LATENCY_WARNING_MS: 2_000, LATENCY_CRITICAL_MS: 5_000 },
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitMetrics: vi.fn().mockResolvedValue(undefined),
}));

import { runAllProbes, runProbe } from './integrationHealthService';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

function respondWith(status: number): void {
  h.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status }));
}

describe('integrationHealthService probes', () => {
  beforeEach(() => {
    h.recordCheck.mockReset().mockImplementation(async (check: unknown) => check);
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

  it('marks Slack unhealthy when api.test answers 200 with ok: false', async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'service_unavailable' }), { status: 200 })
    );

    const check = await runProbe('slack');

    expect(check).toMatchObject({ integration: 'slack', status: 'unhealthy', error: 'service_unavailable' });
  });

  it('marks Slack healthy when api.test answers ok: true', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    expect(await runProbe('slack')).toMatchObject({ integration: 'slack', status: 'healthy', error: null });
  });
});
