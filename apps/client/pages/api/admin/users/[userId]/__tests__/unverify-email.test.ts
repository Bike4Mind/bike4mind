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
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/auditLog', () => ({ logAuditEvent: vi.fn(), EmailAuditEvents: {} }));

await import('../unverify-email');

const makeReq = () => ({
  query: { userId: 'user-1' },
  user: { id: 'admin-1', username: 'admin', isAdmin: true },
  headers: {},
  logger: { info: vi.fn() },
});

describe('POST /api/admin/users/[userId]/unverify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes exactly the verification fields', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      email: 'a@b.test',
    });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', emailVerified: false, emailVerifiedAt: null });
    expect(json).toHaveBeenCalledWith({ message: 'Email unverified successfully' });
  });

  it('does not write an already-unverified user', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', emailVerified: false });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ alreadyUnverified: true }));
  });

  it('rejects a non-admin caller without writing', async () => {
    const req = { ...makeReq(), user: { id: 'u-2', username: 'x', isAdmin: false } };

    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow(/Admin access required/);
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});
