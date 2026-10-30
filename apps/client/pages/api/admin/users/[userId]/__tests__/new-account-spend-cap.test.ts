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
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

await import('../new-account-spend-cap');

const REASON = 'Verified the integration owner';

const makeReq = (body: unknown, isAdmin = true) => ({
  query: { userId: 'user-1' },
  body,
  user: { id: 'admin-1', username: 'admin', isAdmin },
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

describe('POST /api/admin/users/[userId]/new-account-spend-cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a non-admin before touching the user', async () => {
    await expect(h.handler!(makeReq({ lifted: true }, false), { json: vi.fn() })).rejects.toThrow(/admin/i);

    expect(h.findById).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('lifts the cap for a capped user and audits the change', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@b.test', newAccountSpendCapLifted: false });
    const json = vi.fn();

    await h.handler!(makeReq({ lifted: true, reason: REASON }), { json });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', newAccountSpendCapLifted: true });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.new_account_spend_cap.lifted',
        reason: REASON,
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        changes: [{ field: 'newAccountSpendCapLifted', before: false, after: true }],
      })
    );
    expect(json).toHaveBeenCalledWith({ newAccountSpendCapLifted: true });
  });

  it('restores the cap for a lifted user and audits the change', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', newAccountSpendCapLifted: true });
    const json = vi.fn();

    await h.handler!(makeReq({ lifted: false, reason: REASON }), { json });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', newAccountSpendCapLifted: false });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.new_account_spend_cap.restored',
        reason: REASON,
        changes: [{ field: 'newAccountSpendCapLifted', before: true, after: false }],
      })
    );
    expect(json).toHaveBeenCalledWith({ newAccountSpendCapLifted: false });
  });

  it('treats a missing flag as capped, so restoring is a no-op', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u' });
    const json = vi.fn();

    await h.handler!(makeReq({ lifted: false, reason: REASON }), { json });

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ newAccountSpendCapLifted: false });
  });

  it.each([{}, { lifted: 'yes' }, null])('rejects an invalid body %j', async body => {
    await expect(h.handler!(makeReq(body), { json: vi.fn() })).rejects.toThrow(/invalid request body/i);

    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ lifted: true }, /outdated version/],
    [{ lifted: true, reason: 'no' }, /at least/i],
  ])('rejects a missing or too-short reason %j with no write and no audit', async (body, message) => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', newAccountSpendCapLifted: false });

    await expect(h.handler!(makeReq(body), { json: vi.fn() })).rejects.toThrow(message);

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
