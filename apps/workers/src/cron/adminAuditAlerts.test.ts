import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getSettingsMap: vi.fn(),
  postMessageToSlack: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@server/auth/impersonation', () => ({ reconcileExpiredImpersonations: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  adminAuditAlertStateRepository: { name: 'alertState' },
  adminAuditLogRepository: { name: 'auditLog' },
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ adminAuditService: { dispatchAdminAuditAlerts: h.dispatch } }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: h.getSettingsMap,
  getSettingsValue: (key: string, settings: Record<string, string>) => settings[key] ?? '',
  postMessageToSlack: h.postMessageToSlack,
}));

import { runAdminAuditAlerts } from './adminAuditAlerts';

describe('runAdminAuditAlerts', () => {
  beforeEach(() => {
    h.dispatch.mockResolvedValue({ status: 'ran', scanned: 0, alerted: 0, blocked: false });
    h.getSettingsMap.mockResolvedValue({ SlackSecurityAlertsWebhookUrl: '  https://hooks.example.com/x  ' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('reads the webhook fresh each run and wires the repositories and Slack poster', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com/');
    await runAdminAuditAlerts();

    expect(h.getSettingsMap).toHaveBeenCalledWith(expect.anything(), {
      skipCache: true,
      names: ['SlackSecurityAlertsWebhookUrl'],
    });
    const adapters = h.dispatch.mock.calls[0][0];
    expect(adapters.webhookUrl).toBe('https://hooks.example.com/x');
    expect(adapters.postMessage).toBe(h.postMessageToSlack);
    expect(adapters.db).toEqual({ adminAuditLog: { name: 'auditLog' }, alertState: { name: 'alertState' } });
    expect(adapters.toAppUrl('/admin?tab=audit-log')).toBe('https://app.example.com/admin?tab=audit-log');
  });

  it('leaves links out when APP_URL is unset', async () => {
    vi.stubEnv('APP_URL', '');
    await runAdminAuditAlerts();
    expect(h.dispatch.mock.calls[0][0].toAppUrl('/admin')).toBeNull();
  });
});
