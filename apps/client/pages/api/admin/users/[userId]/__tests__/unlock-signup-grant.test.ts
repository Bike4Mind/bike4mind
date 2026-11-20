import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  uses: [] as Array<(req: unknown, res: unknown, next: () => void) => void>,
  unlock: vi.fn(),
  findById: vi.fn(),
  audit: vi.fn(),
  denySelf: vi.fn(),
  policy: vi.fn(),
  append: vi.fn(),
  selfOrImpersonator: vi.fn(),
  protection: { repository: {} },
}));
vi.mock('@bike4mind/server-utils/auth/signupProtection', () => ({ signupProtection: h.protection }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    const chain = {
      use: (fn: unknown) => {
        if (typeof fn === 'function') h.uses.push(fn as (typeof h.uses)[number]);
        return chain;
      },
      post: (fn: typeof h.handler) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrf' }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById },
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: { releaseRemainingSignupGrant: h.unlock } }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  denySelfAdminAction: h.denySelf,
  isSelfOrImpersonator: h.selfOrImpersonator,
  parseAdminActionReason: (reason: string) => {
    if (!reason) throw new Error('reason required');
    return reason;
  },
  loadCreditGrantPolicy: () => h.policy(),
  recordAdminActionFromRequest: h.audit,
}));
await import('../unlock-signup-grant');
const invoke = async (req: unknown, res: unknown) => {
  for (const middleware of h.uses) middleware(req, res, () => undefined);
  return h.handler!(req, res);
};
const request = () => ({
  method: 'POST',
  query: { userId: 'user-1' },
  user: { id: 'admin-1', isAdmin: true } as Record<string, unknown>,
  body: { reason: 'Support approved request', unlockReason: 'card_verified' },
});

describe('admin signup unlock', () => {
  it('passes the shared domain protection to the staged release', async () => {
    await h.handler!(request(), { json: vi.fn() });
    expect(h.unlock.mock.calls[0][1].db.signupProtection).toBe(h.protection);
  });

  it('answers with the explicit outcome, so a release with nothing to pay is a reasoned no-op', async () => {
    h.unlock.mockResolvedValue({ outcome: 'noop', reason: 'no_grant' });
    const res = { json: vi.fn() };
    await h.handler!(request(), res);
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ outcome: 'noop', reason: 'no_grant' });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockReset().mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
    h.selfOrImpersonator.mockImplementation((user: { id: string; impersonatedBy?: string }, targetId: string) =>
      [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase())
    );
    h.denySelf.mockRejectedValue(new Error('Admins cannot perform this action on their own account.'));
    h.unlock.mockResolvedValue({ outcome: 'noop', reason: 'nothing_remaining' });
  });
  it('is jwt-only and refuses a caller without credits:adjust before invoking the grant', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    for (const user of [
      { id: 'admin-1', isAdmin: false },
      { id: 'admin-1', adminPermissions: ['support:read'] },
    ]) {
      await expect(invoke({ ...request(), user }, { json: vi.fn() })).rejects.toThrow(
        'Missing permission: credits:adjust'
      );
    }
    expect(h.unlock).not.toHaveBeenCalled();
  });
  it('lets a delegate holding credits:adjust release', async () => {
    await invoke({ ...request(), user: { id: 'admin-1', adminPermissions: ['credits:adjust'] } }, { json: vi.fn() });
    expect(h.unlock).toHaveBeenCalledOnce();
  });
  it('requires an audit reason', async () => {
    const req = request();
    req.body.reason = '';
    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow('reason required');
    expect(h.unlock).not.toHaveBeenCalled();
  });
  it('does not release or audit when reading the target fails', async () => {
    h.findById.mockRejectedValueOnce(new Error('lookup unavailable'));

    await expect(h.handler!(request(), { json: vi.fn() })).rejects.toThrow('lookup unavailable');

    expect(h.unlock).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
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
    const [id, adapters] = h.unlock.mock.calls[0];
    expect(h.denySelf).not.toHaveBeenCalled();
    expect(id).toBe('user-1');
    h.findById.mockResolvedValue({ isAdmin: false });
    expect(await adapters.validators.admin()).toBe(false);
    h.findById.mockResolvedValue({ isAdmin: true });
    expect(await adapters.validators.admin()).toBe(true);
    h.findById.mockResolvedValue({ adminPermissions: ['credits:adjust'] });
    expect(await adapters.validators.admin()).toBe(true);
    h.findById.mockResolvedValue({ adminPermissions: ['support:read'] });
    expect(await adapters.validators.admin()).toBe(false);
    h.findById.mockResolvedValue(null);
    expect(await adapters.validators.admin()).toBe(false);
    await adapters.audit({ credits: 28, creditTransactionId: 'tx-1' });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.credits.adjusted',
        target: { kind: 'user', id: 'user-1', displayName: 'user@example.com' },
        related: { creditTransactionId: 'tx-1' },
      })
    );
  });
  it.each([
    ['a full admin', { id: 'user-1', isAdmin: true }],
    ['another delegate', { id: 'user-1', adminPermissions: ['support:read'] }],
  ])('refuses a delegate acting on %s before any credits move', async (_label, target) => {
    h.findById.mockResolvedValue(target);
    const delegate = { id: 'admin-1', isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(h.handler!({ ...request(), user: delegate }, { json: vi.fn() })).rejects.toThrow(
      'Only full administrators can release signup credits for users with admin access'
    );
    expect(h.unlock).not.toHaveBeenCalled();
  });
  it('lets a full admin act on an account with admin access', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', isAdmin: true });
    await h.handler!(request(), { json: vi.fn() });
    expect(h.unlock).toHaveBeenCalledOnce();
  });
});

describe('large-grant threshold on the audit entry', () => {
  const THRESHOLD = 100;
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockReset().mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
    h.audit.mockReset();
  });
  const entryFor = async (credits: number) => {
    h.append.mockClear();
    h.policy.mockResolvedValue({
      singleGrantCredits: THRESHOLD,
      dailyTotalCredits: 1_000_000,
      sumCreditsGranted: vi.fn().mockResolvedValue(0),
    });
    const { adminAuditService } = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
    h.audit.mockImplementation(
      async (_req: unknown, input: Parameters<typeof adminAuditService.recordAdminAction>[0]) =>
        adminAuditService.recordAdminAction(
          { ...input, actor: { kind: 'user', scope: 'platform', userId: 'admin-1' }, context: {} } as never,
          { db: { adminAuditLog: { append: h.append } }, creditGrantPolicy: await h.policy() }
        )
    );
    h.unlock.mockImplementation(async (_id: string, adapters: { audit: (r: { credits: number }) => Promise<void> }) => {
      await adapters.audit({ credits });
      return { outcome: 'applied', credits };
    });
    await h.handler!(request(), { json: vi.fn() });
    return h.append.mock.calls[0][0];
  };

  it.each([
    ['above', THRESHOLD + 1, 'critical'],
    ['at', THRESHOLD, 'notice'],
  ])('records the reason and the severity for a grant %s the threshold', async (_label, credits, severity) => {
    const entry = await entryFor(credits as number);
    expect(entry.reason).toBe('Support approved request');
    expect(entry.severity).toBe(severity);
    expect(entry.details.credits).toBe(credits);
    if (severity === 'critical')
      expect(entry.details.grantThresholdExceeded).toEqual({ kind: 'singleGrant', limitCredits: THRESHOLD });
    else expect(entry.details.grantThresholdExceeded).toBeUndefined();
  });

  it.each([
    ['above', THRESHOLD + 1],
    ['below', THRESHOLD - 1],
  ])('still rejects a grant %s the threshold with no reason, and pays nothing', async (_label, credits) => {
    h.unlock.mockResolvedValue({ outcome: 'applied', credits });
    const req = { ...request(), body: {} };
    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow('reason required');
    expect(h.unlock).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
});
