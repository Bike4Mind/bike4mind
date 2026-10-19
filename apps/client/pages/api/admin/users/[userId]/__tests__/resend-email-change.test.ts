import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: () => ({
      post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        h.handler = fn;
        return {};
      },
    }),
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: h.findById, update: h.update } }));
vi.mock('@bike4mind/services', () => ({ userService: { cancelEmailChange: vi.fn() } }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@server/utils/mailer/emailHelpers', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/mailer/emailHelpers')>()),
  generateVerificationLink: () => 'http://x/verify-email?t=1',
  getLogoUrl: () => 'logo',
  buildEmailLogoImg: () => '',
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

await import('../resend-email-change');

describe('POST /api/admin/users/[userId]/resend-email-change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes exactly the resent timestamp', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      email: 'a@b.test',
      pendingEmail: 'new@b.test',
      pendingEmailToken: 'tok',
    });
    const json = vi.fn();

    await h.handler!(
      {
        query: { userId: 'user-1' },
        user: { id: 'admin-1', username: 'admin', isAdmin: true },
        headers: {},
        logger: { info: vi.fn() },
      },
      { json }
    );

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'user-1', pendingEmailSentAt: expect.any(Date) });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.change_resent',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
      })
    );
  });

  it('records user.email.change_cancelled when the pending token has expired', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      email: 'a@b.test',
      pendingEmail: 'new@b.test',
      pendingEmailToken: 'tok',
      pendingEmailExpires: new Date(Date.now() - 60_000),
    });

    await expect(
      h.handler!(
        {
          query: { userId: 'user-1' },
          user: { id: 'admin-1', username: 'admin', isAdmin: true },
          headers: {},
          logger: { info: vi.fn() },
        },
        { json: vi.fn() }
      )
    ).rejects.toThrow(/automatically cancelled/);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.change_cancelled',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
      })
    );
  });

  it('escapes the username and both addresses in the email body', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: '<b>x</b>',
      email: 'a&b@b.test',
      pendingEmail: '"new"@b.test',
      pendingEmailToken: 'tok',
    });

    await h.handler!(
      {
        query: { userId: 'user-1' },
        user: { id: 'admin-1', username: 'admin', isAdmin: true },
        headers: {},
        logger: { info: vi.fn() },
      },
      { json: vi.fn() }
    );

    const { body } = h.publish.mock.calls[0][0] as { body: string };
    expect(body).toContain('Hello &lt;b&gt;x&lt;/b&gt;,');
    expect(body).toContain('<strong>a&amp;b@b.test</strong> to <strong>&quot;new&quot;@b.test</strong>');
  });
});
