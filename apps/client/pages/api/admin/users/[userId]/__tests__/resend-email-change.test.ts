import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  update: vi.fn(),
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
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@server/utils/mailer/emailHelpers', () => ({
  generateVerificationLink: () => 'http://x/verify-email?t=1',
  getLogoUrl: () => 'logo',
  buildEmailLogoImg: () => '',
}));
vi.mock('@server/utils/auditLog', () => ({ logAuditEvent: vi.fn(), EmailAuditEvents: {} }));

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
  });
});
