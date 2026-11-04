import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  run: vi.fn(),
  preview: vi.fn(),
  findTargets: vi.fn(),
  audit: vi.fn(),
  denySelf: vi.fn(),
  rewards: { pauseForUser: vi.fn(), resumeForUser: vi.fn() },
  rerun: vi.fn(),
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
vi.mock('@server/credits/rerunDomainGrantAfterUnblock', () => ({ rerunDomainGrantAfterUnblock: h.rerun }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findAdminTargetsByIds: h.findTargets },
  heldCreditRewardRepository: h.rewards,
}));
vi.mock('@bike4mind/services', () => ({
  userService: {
    MAX_BULK_SIGNUP_GRANT_ACTION: 100,
    bulkSetSignupGrantBlock: h.run,
    previewSignupGrantAction: h.preview,
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  denySelfAdminAction: h.denySelf,
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, targetId: string) =>
    [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase()),
  parseAdminActionReason: (reason: string) => {
    if (!reason) throw new Error('reason required');
    return reason;
  },
  recordAdminActionFromRequest: h.audit,
}));
await import('../bulk-unblock');

const id = (n: number) => String(n).padStart(24, '0');
const request = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'admin-1', isAdmin: true },
  body: { userIds: [id(1), id(2)], reason: 'Confirmed farming ring' },
  logger: { error: vi.fn() },
  ...overrides,
});

describe('admin bulk unblock signup grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.denySelf.mockRejectedValue(new Error('Admins cannot perform this action on their own account.'));
    h.findTargets.mockResolvedValue([
      { id: id(1), email: 'one@example.com' },
      { id: id(2), username: 'two' },
    ]);
    h.run.mockResolvedValue({ dryRun: false, results: [], undoUserIds: [] });
    h.preview.mockResolvedValue({ dryRun: true, results: [], undoUserIds: [] });
  });

  it('is jwt-only and gated on the credits permission for POST', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } });
  });

  it.each([
    ['empty ids', { userIds: [], reason: 'x' }],
    ['a malformed id', { userIds: ['nope'], reason: 'x' }],
    ['over the cap', { userIds: Array.from({ length: 101 }, (_, n) => id(n)), reason: 'x' }],
  ])('rejects %s before touching anything', async (_label, body) => {
    await expect(h.handler!(request({ body }), { json: vi.fn() })).rejects.toThrow('user ids');
    expect(h.run).not.toHaveBeenCalled();
  });

  it('requires a reason for a real run', async () => {
    await expect(h.handler!(request({ body: { userIds: [id(1)], reason: '' } }), { json: vi.fn() })).rejects.toThrow(
      'reason required'
    );
    expect(h.run).not.toHaveBeenCalled();
  });

  it('refuses the whole request when it names the admin own account', async () => {
    await expect(h.handler!(request({ user: { id: id(2), isAdmin: true } }), { json: vi.fn() })).rejects.toThrow(
      'own account'
    );
    expect(h.denySelf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.credits.denied', attempted: 'user.credits.grant_unblocked' })
    );
    expect(h.run).not.toHaveBeenCalled();
  });

  it('refuses the whole request when a delegated admin names an account with admin access', async () => {
    h.findTargets.mockResolvedValue([{ id: id(1) }, { id: id(2), isAdmin: true }]);
    const delegate = { id: 'admin-2', isAdmin: false, adminPermissions: ['credits:adjust'] };

    await expect(h.handler!(request({ user: delegate }), { json: vi.fn() })).rejects.toThrow(
      'Only full administrators'
    );
    expect(h.run).not.toHaveBeenCalled();
  });

  it('previews on a dry run without a reason, writing and auditing nothing', async () => {
    const res = { json: vi.fn() };
    await h.handler!(request({ body: { userIds: [id(1)], dryRun: true } }), res);

    expect(h.preview).toHaveBeenCalledExactlyOnceWith(
      { action: 'unblock', userIds: [id(1)] },
      { users: { findAdminTargetsByIds: h.findTargets } }
    );
    expect(res.json).toHaveBeenCalledWith({ dryRun: true, results: [], undoUserIds: [] });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('runs the bulk action and builds one audit write per account with the reason', async () => {
    const res = { json: vi.fn() };
    await h.handler!(request(), res);

    const [input, adapters] = h.run.mock.calls[0];
    expect(input).toEqual({ action: 'unblock', userIds: [id(1), id(2)] });
    expect(adapters.heldRewards).toBe(h.rewards);
    expect(h.audit).not.toHaveBeenCalled();
    await adapters.auditFor(id(2))();
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.credits.grant_unblocked',
        reason: 'Confirmed farming ring',
        target: { kind: 'user', id: id(2), displayName: 'two' },
      })
    );
    expect(res.json).toHaveBeenCalledOnce();
  });

  it('re-runs the domain grant for each unblocked account only, like the single unblock', async () => {
    h.run.mockResolvedValue({ dryRun: false, results: [], undoUserIds: [id(2)] });
    await h.handler!(request(), { json: vi.fn() });

    expect(h.rerun).toHaveBeenCalledExactlyOnceWith(id(2), expect.anything());
  });

  it('does not re-run the domain grant on a dry run', async () => {
    await h.handler!(request({ body: { userIds: [id(1)], dryRun: true } }), { json: vi.fn() });

    expect(h.rerun).not.toHaveBeenCalled();
  });
});
