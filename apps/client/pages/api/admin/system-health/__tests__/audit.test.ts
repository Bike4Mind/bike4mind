import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: any, res: any) => unknown;
const { handlers } = vi.hoisted(() => ({ handlers: {} as Record<string, Record<string, Handler>> }));
const state = vi.hoisted(() => ({ current: '' }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const bucket: Record<string, Handler> = {};
    handlers[state.current] = bucket;
    const chain: any = { use: () => chain };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      chain[method] = (fn: Handler) => {
        bucket[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));
const mocks = vi.hoisted(() => ({ sendTestEmail: vi.fn(), ping: vi.fn() }));
vi.mock('@server/utils/mailer', () => ({
  MailService: class {
    sendTestEmail = mocks.sendTestEmail;
  },
}));
vi.mock('mongoose', () => ({
  default: { connection: { readyState: 1, db: { admin: () => ({ ping: mocks.ping }) } } },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/auth/oktaOidcClient', () => ({ getOktaConfigStatus: vi.fn() }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

state.current = 'email';
await import('../test-email');
state.current = 'database';
await import('../test-database');
state.current = 'oauth';
await import('../test-oauth');

const adminReq = (body: object = {}) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = { id: 'admin-1', isAdmin: true, email: 'admin@example.test' };
  return { req, res };
};

const expectTestRun = (req: unknown, details: Record<string, unknown>) =>
  expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
    req,
    expect.objectContaining({
      action: 'system_health.test_run',
      target: { kind: 'system', id: 'system-health', displayName: 'System health' },
      details: expect.objectContaining(details),
    })
  );

describe('system health test audit entries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendTestEmail.mockResolvedValue({ success: true });
    mocks.ping.mockResolvedValue({ ok: 1 });
  });

  it('records the email test', async () => {
    const { req, res } = adminReq();
    await handlers.email.post(req, res);
    expectTestRun(req, { testType: 'email' });
  });

  it('records the database test', async () => {
    const { req, res } = adminReq();
    await handlers.database.post(req, res);
    expectTestRun(req, { testType: 'database' });
  });

  it('records the oauth test with the provider and outcome', async () => {
    const { req, res } = adminReq({ provider: 'github' });
    await handlers.oauth.post(req, res);
    expectTestRun(req, { testType: 'oauth', provider: 'github', success: false });
  });
});
