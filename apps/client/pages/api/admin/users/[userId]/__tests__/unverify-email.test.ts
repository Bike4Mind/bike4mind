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
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

await import('../unverify-email');

const REASON = 'Support ticket confirmed the address';

const makeReq = (body: unknown = { reason: REASON }) => ({
  query: { userId: 'user-1' },
  body,
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

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.unverified',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        reason: REASON,
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

  it.each([
    [{}, /outdated version/],
    [{ reason: 'no' }, /at least/i],
  ])('rejects a missing or too-short reason %j with no write and no audit', async (body, message) => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      email: 'a@b.test',
    });

    await expect(h.handler!(makeReq(body), { json: vi.fn() })).rejects.toThrow(message);

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
