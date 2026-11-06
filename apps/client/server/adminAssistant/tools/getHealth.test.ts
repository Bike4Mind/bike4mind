import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const getSystemHealthStatus = vi.fn();
vi.mock('@server/admin/systemHealth/getSystemHealthStatus', () => ({
  getSystemHealthStatus: (...args: unknown[]) => getSystemHealthStatus(...args),
}));
const getHealthSummary = vi.fn();
vi.mock('@bike4mind/server-utils/services/integrationHealthService', () => ({
  getHealthSummary: (...args: unknown[]) => getHealthSummary(...args),
}));

const getStatus = vi.fn();
vi.mock('@bike4mind/server-utils/services/integrationCircuitBreaker', () => ({
  getStatus: (...args: unknown[]) => getStatus(...args),
}));

import { getHealthTool } from './getHealth';

const breaker = { available: true, reason: null, mode: 'auto', autoTripped: false };

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const context = { user: { isAdmin: true }, userId: 'admin-1', logger } as unknown as Omit<ToolContext, 'config'>;

const runTool = async (args: unknown) =>
  JSON.parse(await getHealthTool.implementation(context, undefined).toolFn(args));

const systemStatus = {
  email: { configured: false, missingSecrets: ['MAIL_HOST'], secrets: { MAIL_HOST: false } },
  database: { type: 'MongoAtlas', connected: true, readyState: 1 },
  oauth: {
    google: { configured: true, missingSecrets: [] },
    github: { configured: false, missingSecrets: ['GITHUB_CLIENT_SECRET'] },
    okta: { configured: false, missingSecrets: ['OKTA_CLIENT_ID'], effectiveSource: 'none' },
  },
};

const summary = (overrides: Record<string, unknown> = {}) => ({
  integration: 'slack',
  status: 'healthy',
  latencyMs: 120,
  lastCheckedAt: new Date('2026-11-05T10:00:00.000Z'),
  successRate: 0.98,
  consecutiveFailures: 0,
  error: null,
  ...overrides,
});

describe('getHealthTool', () => {
  beforeEach(() => {
    getSystemHealthStatus.mockReset().mockResolvedValue(systemStatus);
    getHealthSummary.mockReset().mockResolvedValue([summary()]);
    getStatus.mockReset().mockResolvedValue(breaker);
  });

  it('combines the system config status with the stored integration checks', async () => {
    const result = await runTool({});

    expect(getHealthSummary).toHaveBeenCalledWith(logger);
    expect(getStatus).toHaveBeenCalledWith('slack');
    expect(result).toEqual({
      ok: true,
      data: {
        ...systemStatus,
        integrations: [
          { ...summary(), lastCheckedAt: '2026-11-05T10:00:00.000Z', neverChecked: false, circuitBreaker: breaker },
        ],
      },
    });
  });

  it('reports a never-checked integration with a null lastCheckedAt', async () => {
    getHealthSummary.mockResolvedValue([summary({ status: 'unhealthy', lastCheckedAt: new Date(0), latencyMs: 0 })]);

    const result = await runTool({});

    expect(result.data.integrations[0]).toMatchObject({
      status: 'unhealthy',
      lastCheckedAt: null,
      neverChecked: true,
    });
  });

  it('fails closed when a source throws', async () => {
    getHealthSummary.mockRejectedValue(new Error('db down'));

    expect(await runTool({})).toEqual({ ok: false, error: 'failed', message: 'The tool failed to run.' });
  });
});
