import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => ({
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
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

await import('../unverify-email');

const admin = { id: 'admin-1', username: 'admin', isAdmin: true };
const delegate = { id: 'del-1', username: 'del', isAdmin: false, adminPermissions: ['settings:manage'] };

const makeReq = (user: Record<string, unknown> = admin) => ({
  query: { userId: 'user-1' },
  user,
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

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.unverified',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
      })
    );
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

  it('refuses a delegated operator unverifying a user with admin access, without writing or auditing', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', emailVerified: true, adminPermissions: ['support:read'] });

    await expect(h.handler!(makeReq(delegate), { json: vi.fn() })).rejects.toThrow(
      /Only full administrators can unverify the email of users with admin access/
    );

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('lets a full admin unverify a user with admin access', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', emailVerified: true, adminPermissions: ['support:read'] });
    const json = vi.fn();

    await h.handler!(makeReq(admin), { json });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({ message: 'Email unverified successfully' });
  });
});
