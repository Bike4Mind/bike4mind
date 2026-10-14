import { describe, it, expect, vi, beforeEach } from 'vitest';

type Mailer = {
  sendEmailChangeNotification: (user: unknown, newEmail: string) => Promise<void>;
  sendEmailChangeVerification: (user: unknown, newEmail: string, token: string) => Promise<void>;
};

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  requestEmailChange: vi.fn(),
  publish: vi.fn(),
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({ userService: { requestEmailChange: h.requestEmailChange } }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@server/utils/auditLog', () => ({ logAuditEvent: vi.fn(), EmailAuditEvents: {} }));

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
});
