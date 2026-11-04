import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  block: vi.fn(),
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
vi.mock('@bike4mind/services', () => ({ userService: { blockSignupGrant: h.block } }));
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
await import('../block-signup-grant');

const request = (overrides: Record<string, unknown> = {}) => ({
  query: { userId: 'user-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Confirmed farming ring' },
  ...overrides,
});

describe('admin block signup grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.denySelf.mockRejectedValue(new Error('Admins cannot perform this action on their own account.'));
    h.findById.mockResolvedValue({ id: 'user-1' });
    h.block.mockResolvedValue({ outcome: 'applied', credits: 0, rewardsAffected: 2 });
  });

  it('is jwt-only and gated on the credits permission for POST', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } });
  });

  it('requires a reason before touching the account', async () => {
    await expect(h.handler!(request({ body: { reason: '' } }), { json: vi.fn() })).rejects.toThrow('reason required');
    expect(h.block).not.toHaveBeenCalled();
  });

  it('denies and audits a block on the admin own account', async () => {
    await expect(h.handler!(request({ user: { id: 'USER-1', isAdmin: true } }), { json: vi.fn() })).rejects.toThrow(
      'own account'
    );
    expect(h.denySelf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.credits.denied',
        attempted: 'user.credits.grant_blocked',
      })
    );
    expect(h.block).not.toHaveBeenCalled();
  });

  it('stops a delegated admin from blocking an account with admin access', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', isAdmin: true });
    const delegate = { id: 'admin-2', isAdmin: false, adminPermissions: ['credits:adjust'] };

    await expect(h.handler!(request({ user: delegate }), { json: vi.fn() })).rejects.toThrow(
      'Only full administrators can block signup credit grants for users with admin access'
    );
    expect(h.block).not.toHaveBeenCalled();
  });

  it('returns the service result and audits with the reason inside the change', async () => {
    const res = { json: vi.fn() };
    await h.handler!(request(), res);

    expect(res.json).toHaveBeenCalledExactlyOnceWith({ outcome: 'applied', credits: 0, rewardsAffected: 2 });
    const [userId, adapters] = h.block.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(adapters.heldRewards).toBe(h.rewards);
    expect(h.audit).not.toHaveBeenCalled();
    await adapters.audit();
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.credits.grant_blocked',
        reason: 'Confirmed farming ring',
        target: { kind: 'user', id: 'user-1', displayName: 'user-1' },
      })
    );
  });
});
