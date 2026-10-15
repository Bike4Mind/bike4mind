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

vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, update: h.update },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
const mockApplyGrants = vi.hoisted(() => vi.fn());
vi.mock('@server/auth/emailVerifiedGrants', () => ({
  applyEmailVerifiedGrants: (...a: unknown[]) => mockApplyGrants(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/auditLog', () => ({ logAuditEvent: vi.fn(), EmailAuditEvents: {} }));

await import('../verify-email');

const makeReq = () => ({
  query: { userId: 'user-1' },
  user: { id: 'admin-1', username: 'admin', isAdmin: true },
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

describe('POST /api/admin/users/[userId]/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes exactly the verification fields, clearing the single-use token', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', emailVerified: false, email: 'a@b.test' });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith({
      id: 'user-1',
      emailVerified: true,
      emailVerifiedAt: expect.any(Date),
      emailVerificationToken: null,
      emailVerificationExpires: null,
      emailVerificationSentAt: null,
    });
    expect(json).toHaveBeenCalledWith({ message: 'Email verified successfully' });
  });

  it('applies the email-verified grants after the verification write', async () => {
    const user = { id: 'user-1', username: 'u', emailVerified: false, email: 'a@b.test' };
    h.findById.mockResolvedValue(user);
    const req = makeReq();

    await h.handler!(req, { json: vi.fn() });

    expect(mockApplyGrants).toHaveBeenCalledTimes(1);
    expect(mockApplyGrants).toHaveBeenCalledWith({
      user,
      verifiedEmail: 'a@b.test',
      trigger: 'admin-verification',
      releaseReason: 'admin verified email',
      logger: req.logger,
    });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(mockApplyGrants.mock.invocationCallOrder[0]);
  });

  it('skips the grants for a user without an email', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', emailVerified: false });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(mockApplyGrants).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ message: 'Email verified successfully' });
  });

  it('does not write an already-verified user', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', emailVerified: true });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).not.toHaveBeenCalled();
    expect(mockApplyGrants).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ alreadyVerified: true }));
  });
});
