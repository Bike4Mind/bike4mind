import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { mockGetSettingsMap } = vi.hoisted(() => ({ mockGetSettingsMap: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => mockGetSettingsMap(...a),
}));

import handler from '../alert-status';

const call = (user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET' });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockGetSettingsMap.mockReset().mockResolvedValue({});
});

describe('GET /api/admin/audit-log/alert-status', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    const scopes = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes;
    expect(scopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin with 403', async () => {
    await expect(call({ id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it('reports alerts off and the default thresholds when nothing is set', async () => {
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData()).toEqual({ alertsEnabled: false, singleGrantCredits: 50000, dailyGrantCredits: 200000 });
  });

  it('reports alerts on without exposing the webhook, and the configured thresholds', async () => {
    mockGetSettingsMap.mockResolvedValue({
      SlackSecurityAlertsWebhookUrl: 'https://hooks.example.com/secret',
      AdminAuditCriticalGrantCredits: '10000',
      AdminAuditDailyGrantCredits: '40000',
    });
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData()).toEqual({ alertsEnabled: true, singleGrantCredits: 10000, dailyGrantCredits: 40000 });
    expect(JSON.stringify(res._getJSONData())).not.toContain('hooks.example.com');
  });

  it('treats a whitespace-only webhook as unset', async () => {
    mockGetSettingsMap.mockResolvedValue({ SlackSecurityAlertsWebhookUrl: '   ' });
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData()).toMatchObject({ alertsEnabled: false });
  });
});
