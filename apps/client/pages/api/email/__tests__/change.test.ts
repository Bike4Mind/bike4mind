import { describe, it, expect, vi, beforeEach } from 'vitest';

type Mailer = {
  sendEmailChangeNotification: (user: unknown, newEmail: string) => Promise<void>;
  sendEmailChangeVerification: (user: unknown, newEmail: string, token: string) => Promise<void>;
};

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  requestEmailChange: vi.fn(),
  publish: vi.fn(),
  logAuditEvent: vi.fn(),
  logAuthAudit: vi.fn(),
  users: { findById: vi.fn(), existsOtherUserWithEmail: vi.fn(), update: vi.fn() },
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: h.users,
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({ userService: { requestEmailChange: h.requestEmailChange } }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
// logAuditEvent writes a CounterLog row; an own email change must never reach it.
vi.mock('@server/utils/auditLog', () => ({ logAuditEvent: h.logAuditEvent }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.logAuthAudit }));

process.env.APP_URL = 'https://app.test';
await import('../change');

const user = { id: 'user-1', username: '<b>x</b>', email: 'old&co@b.test' };
const newEmail = 'new@b.test';

const run = async () => {
  await h.handler!(
    {
      body: { newEmail },
      user,
      ip: '127.0.0.1',
      headers: {},
      logger: { error: vi.fn() },
    },
    { json: vi.fn() }
  );
  return h.publish.mock.calls.map(call => call[0] as { to: string; body: string });
};

describe('POST /api/email/change templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requestEmailChange.mockImplementation(async (_params: unknown, { mailer }: { mailer: Mailer }) => {
      await mailer.sendEmailChangeNotification(user, newEmail);
      await mailer.sendEmailChangeVerification(user, newEmail, 'tok');
    });
  });

  it('escapes the username and current address in the notification to the old address', async () => {
    const [notification] = await run();

    expect(notification.to).toBe(user.email);
    expect(notification.body).toContain('Hello &lt;b&gt;x&lt;/b&gt;,');
    expect(notification.body).toContain('<strong>Current email:</strong> old&amp;co@b.test');
    expect(notification.body).not.toContain('<b>x</b>');
  });

  it('escapes the username and addresses in the verification to the new address', async () => {
    const [, verification] = await run();

    expect(verification.to).toBe(newEmail);
    expect(verification.body).toContain('Hello &lt;b&gt;x&lt;/b&gt;,');
    expect(verification.body).toContain('from <strong>old&amp;co@b.test</strong> to <strong>new@b.test</strong>');
    expect(verification.body).not.toContain('<b>x</b>');
  });

  it('normalizes a padded, mixed-case address before it reaches the service', async () => {
    h.requestEmailChange.mockResolvedValue(undefined);

    await h.handler!(
      { body: { newEmail: 'New@X.com ' }, user, ip: '127.0.0.1', headers: {}, logger: { error: vi.fn() } },
      { json: vi.fn() }
    );

    expect(h.requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', newEmail: 'new@x.com' }),
      expect.anything()
    );
  });

  it('wires the user repository into the service and audits the request', async () => {
    h.requestEmailChange.mockImplementation(async (_params: unknown, { db }: { db: { users: typeof h.users } }) => {
      await db.users.findById('user-1');
      await db.users.existsOtherUserWithEmail('new@x.com', 'user-1');
      await db.users.update({ id: 'user-1' });
    });

    await h.handler!(
      {
        body: { newEmail },
        user: { ...user, email: '' },
        ip: '127.0.0.1',
        headers: { 'user-agent': 'agent/1' },
        logger: { error: vi.fn() },
      },
      { json: vi.fn() }
    );

    expect(h.users.findById).toHaveBeenCalledWith('user-1');
    expect(h.users.existsOtherUserWithEmail).toHaveBeenCalledWith('new@x.com', 'user-1');
    expect(h.users.update).toHaveBeenCalledWith({ id: 'user-1' });
    expect(h.logAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: { oldEmail: undefined, newEmail } })
    );
  });

  it('records the request in the user auth audit log, not CounterLog', async () => {
    h.requestEmailChange.mockResolvedValue(undefined);
    const req = { body: { newEmail }, user, ip: '127.0.0.1', headers: {}, logger: { error: vi.fn() } };

    await h.handler!(req, { json: vi.fn() });

    expect(h.logAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'email_change_requested',
      metadata: { oldEmail: user.email, newEmail },
    });
    expect(h.logAuditEvent).not.toHaveBeenCalled();
  });
});
