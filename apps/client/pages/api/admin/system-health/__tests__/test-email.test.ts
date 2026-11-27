import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const h = vi.hoisted(() => ({
  sendLiveTestEmail: vi.fn(),
  audit: vi.fn(),
  routes: {} as Record<string, Handler>,
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const chain = {
      use: () => chain,
      post: (fn: Handler) => {
        h.routes.POST = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@bike4mind/server-utils/utils/mailer/testEmail', () => ({ sendLiveTestEmail: h.sendLiveTestEmail }));

await import('../test-email');

const call = async (body: Record<string, unknown> = {}, user: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as Record<string, unknown>).user = {
    id: 'admin-1',
    isAdmin: true,
    email: 'admin@example.org',
    ...user,
  };
  (req as unknown as Record<string, unknown>).logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  await h.routes.POST(req, res);
  return res;
};

describe('POST /api/admin/system-health/test-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.audit.mockResolvedValue(null);
    h.sendLiveTestEmail.mockResolvedValue({ success: true, messageId: 'ses-1', transport: 'ses' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the live result fields, the transport included, with the recipient and a timestamp', async () => {
    const res = await call({ to: 'qa@example.org' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.sendLiveTestEmail).toHaveBeenCalledExactlyOnceWith('qa@example.org');
    expect(res._getJSONData()).toEqual({
      success: true,
      messageId: 'ses-1',
      transport: 'ses',
      sentTo: 'qa@example.org',
      timestamp: expect.any(String),
    });
  });

  it('returns a failed live result as it is, with the transport and the error', async () => {
    h.sendLiveTestEmail.mockResolvedValue({ success: false, error: 'relay refused the sender', transport: 'smtp' });

    const res = await call({ to: 'qa@example.org' });

    expect(res._getJSONData()).toMatchObject({
      success: false,
      error: 'relay refused the sender',
      transport: 'smtp',
      sentTo: 'qa@example.org',
    });
  });

  it("falls back to the admin's own address when none is given", async () => {
    const res = await call({});

    expect(h.sendLiveTestEmail).toHaveBeenCalledWith('admin@example.org');
    expect(res._getJSONData()).toMatchObject({ sentTo: 'admin@example.org' });
  });

  it('records the test run after the send', async () => {
    await call({ to: 'qa@example.org' });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'system_health.test_run',
      details: { testType: 'email' },
    });
    expect(h.sendLiveTestEmail.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('returns 400 for a malformed address without sending or recording anything', async () => {
    const res = await call({ to: 'not-an-email' });

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ success: false, error: 'Invalid email address format' });
    expect(h.sendLiveTestEmail).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('returns 400 naming the problem when no address is given and the admin has none on file', async () => {
    const res = await call({}, { email: undefined });

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({
      success: false,
      error: 'No email address provided and user has no email on file.',
    });
    expect(h.sendLiveTestEmail).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('returns 500 with a generic error when the live send throws', async () => {
    h.sendLiveTestEmail.mockRejectedValue(new Error('invoke denied'));

    const res = await call({ to: 'qa@example.org' });

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toEqual({ success: false, error: 'Failed to send test email' });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
