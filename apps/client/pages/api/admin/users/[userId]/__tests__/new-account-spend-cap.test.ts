import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  config: null as unknown,
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config: unknown) => {
    h.config = config;
    return {
      use: () => ({
        post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
          h.handler = fn;
          return {};
        },
      }),
    };
  },
}));

vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, update: h.update },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

await import('../new-account-spend-cap');

const REASON = 'Verified the integration owner';

const FULL_ADMIN = { id: 'admin-1', username: 'admin', isAdmin: true };
const DELEGATE = { id: 'delegate-1', username: 'delegate', isAdmin: false, adminPermissions: ['credits:adjust'] };

const makeReq = (body: unknown, user: Record<string, unknown> = FULL_ADMIN) => ({
  query: { userId: 'user-1' },
  body,
  user,
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

describe('POST /api/admin/users/[userId]/new-account-spend-cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is jwt-only and gated on the credits permission', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } });
  });

  it('lets a credits delegate change an account without admin access', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', newAccountSpendCapLifted: false });

    await h.handler!(makeReq({ lifted: true, reason: REASON }, DELEGATE), { json: vi.fn() });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', newAccountSpendCapLifted: true });
  });

  it.each([
    ['full admin', { isAdmin: true }],
    ['delegate', { isAdmin: false, adminPermissions: ['credits:adjust'] }],
  ])('refuses a delegate on a %s target and writes nothing', async (_label, targetAccess) => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', newAccountSpendCapLifted: false, ...targetAccess });

    await expect(h.handler!(makeReq({ lifted: true, reason: REASON }, DELEGATE), { json: vi.fn() })).rejects.toThrow(
      ForbiddenError
    );

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('lets a full admin change an account that has admin access', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', isAdmin: true, newAccountSpendCapLifted: false });

    await h.handler!(makeReq({ lifted: true, reason: REASON }), { json: vi.fn() });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', newAccountSpendCapLifted: true });
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
