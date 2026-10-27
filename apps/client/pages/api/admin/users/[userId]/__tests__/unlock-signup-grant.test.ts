import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  unlock: vi.fn(),
  findById: vi.fn(),
  audit: vi.fn(),
  denySelf: vi.fn(),
  selfOrImpersonator: vi.fn(),
  protection: { repository: {} },
}));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: h.protection }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
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
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: { unlockSignupGrant: h.unlock } }));
vi.mock('@server/utils/adminAudit', () => ({
  denySelfAdminAction: h.denySelf,
  isSelfOrImpersonator: h.selfOrImpersonator,
  parseAdminActionReason: (reason: string) => {
    if (!reason) throw new Error('reason required');
    return reason;
  },
  recordAdminActionFromRequest: h.audit,
}));
await import('../unlock-signup-grant');
const request = () => ({
  query: { userId: 'user-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Support approved request', unlockReason: 'card_verified' },
});

describe('admin signup unlock', () => {
  it('passes the shared domain protection to the staged release', async () => {
    await h.handler!(request(), { json: vi.fn() });
    expect(h.unlock.mock.calls[0][2].db.signupProtection).toBe(h.protection);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.selfOrImpersonator.mockImplementation((user: { id: string; impersonatedBy?: string }, targetId: string) =>
      [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase())
    );
    h.denySelf.mockRejectedValue(new Error('Admins cannot perform this action on their own account.'));
    h.unlock.mockResolvedValue({ creditsGranted: 0 });
  });
  it('is jwt-only and rejects non-admin callers before invoking the grant', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly' });
    const req = request();
    req.user.isAdmin = false;
    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow('Admin access required');
    expect(h.unlock).not.toHaveBeenCalled();
  });
  it('requires an audit reason', async () => {
    const req = request();
    req.body.reason = '';
    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow('reason required');
    expect(h.unlock).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'user-1', isAdmin: true },
    { id: 'USER-1', isAdmin: true },
    { id: 'other-admin', isAdmin: true, impersonatedBy: 'user-1' },
  ])('denies and audits a self credit grant for %j before invoking the service', async user => {
    const req = { ...request(), user };
    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow('own account');
    expect(h.selfOrImpersonator).toHaveBeenCalledExactlyOnceWith(user, 'user-1');
    expect(h.denySelf).toHaveBeenCalledExactlyOnceWith(req, {
      action: 'user.credits.denied',
      attempted: 'user.credits.adjusted',
      target: { kind: 'user', id: 'user-1', displayName: 'user-1' },
    });
    expect(h.unlock).not.toHaveBeenCalled();
  });
  it('uses only the admin reason and rechecks persisted authorization', async () => {
    await h.handler!(request(), { json: vi.fn() });
    const [id, reason, adapters] = h.unlock.mock.calls[0];
    expect(h.denySelf).not.toHaveBeenCalled();
    expect([id, reason]).toEqual(['user-1', 'admin']);
    h.findById.mockResolvedValue({ isAdmin: false });
    expect(await adapters.validators.admin()).toBe(false);
    h.findById.mockResolvedValue({ isAdmin: true });
    expect(await adapters.validators.admin()).toBe(true);
    await adapters.audit({ credits: 28, creditTransactionId: 'tx-1' });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.credits.adjusted', related: { creditTransactionId: 'tx-1' } })
    );
  });
});
