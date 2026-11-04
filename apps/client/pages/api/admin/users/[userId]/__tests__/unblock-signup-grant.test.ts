import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  unblock: vi.fn(),
  findById: vi.fn(),
  audit: vi.fn(),
  denySelf: vi.fn(),
  rewards: { pauseForUser: vi.fn(), resumeForUser: vi.fn() },
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config: unknown) => {
    h.config = config;
    return {
      use: () => ({
        post: (fn: typeof h.handler) => {
          h.handler = fn;
          return {};
        },
      }),
    };
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById },
  heldCreditRewardRepository: h.rewards,
}));
vi.mock('@bike4mind/services', () => ({ userService: { unblockSignupGrant: h.unblock } }));
vi.mock('@server/utils/adminAudit', () => ({
  denySelfAdminAction: h.denySelf,
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, targetId: string) =>
    [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase()),
  parseAdminActionReason: (reason: string) => {
    if (!reason) throw new Error('reason required');
    return reason;
  },
  recordAdminActionFromRequest: h.audit,
}));
await import('../unblock-signup-grant');

const request = (overrides: Record<string, unknown> = {}) => ({
  query: { userId: 'user-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Cleared after review' },
  ...overrides,
});

describe('admin unblock signup grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.denySelf.mockRejectedValue(new Error('Admins cannot perform this action on their own account.'));
    h.findById.mockResolvedValue({ id: 'user-1' });
    h.unblock.mockResolvedValue({ outcome: 'applied', credits: 0, rewardsAffected: 2 });
  });

  it('is jwt-only and gated on the credits permission for POST', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } });
  });

  it('requires a reason before touching the account', async () => {
    await expect(h.handler!(request({ body: {} }), { json: vi.fn() })).rejects.toThrow('reason required');
    expect(h.unblock).not.toHaveBeenCalled();
  });

  it('denies and audits an unblock on the admin own account', async () => {
    await expect(h.handler!(request({ user: { id: 'user-1', isAdmin: true } }), { json: vi.fn() })).rejects.toThrow(
      'own account'
    );
    expect(h.denySelf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attempted: 'user.credits.grant_unblocked' })
    );
    expect(h.unblock).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown account', async () => {
    h.findById.mockResolvedValue(null);

    await expect(h.handler!(request(), { json: vi.fn() })).rejects.toThrow('User not found');
    expect(h.unblock).not.toHaveBeenCalled();
  });

  it('returns the service result and audits with the reason inside the change', async () => {
    const res = { json: vi.fn() };
    await h.handler!(request(), res);

    expect(res.json).toHaveBeenCalledExactlyOnceWith({ outcome: 'applied', credits: 0, rewardsAffected: 2 });
    const [, adapters] = h.unblock.mock.calls[0];
    await adapters.audit();
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.credits.grant_unblocked', reason: 'Cleared after review' })
    );
  });
});
