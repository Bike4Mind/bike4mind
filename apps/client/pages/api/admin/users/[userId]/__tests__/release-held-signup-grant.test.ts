import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  release: vi.fn(),
  findById: vi.fn(),
  audit: vi.fn(),
  denySelf: vi.fn(),
  logger: { error: vi.fn() },
  adapters: { grant: {} },
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
vi.mock('@bike4mind/server-utils/credits/heldSignupGrantAdapters', () => ({
  buildHeldGrantAdapters: () => h.adapters,
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: h.findById } }));
vi.mock('@bike4mind/services', () => ({ userService: { releaseHeldSignupGrant: h.release } }));
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
await import('../release-held-signup-grant');

const request = (overrides: Record<string, unknown> = {}) => ({
  query: { userId: 'user-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Support approved request' },
  logger: h.logger,
  ...overrides,
});

describe('admin release held signup grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockReset().mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
    h.audit.mockReset();
    h.denySelf.mockRejectedValue(new Error('Admins cannot perform this action on their own account.'));
    h.release.mockResolvedValue({ outcome: 'applied', credits: 10 });
  });

  it('is jwt-only and gated on the credits permission for POST', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } });
  });

  it('requires a reason before paying anything', async () => {
    await expect(h.handler!(request({ body: {} }), { json: vi.fn() })).rejects.toThrow('reason required');
    expect(h.release).not.toHaveBeenCalled();
  });

  it('denies and audits a release on the admin own account', async () => {
    await expect(h.handler!(request({ user: { id: 'user-1', isAdmin: true } }), { json: vi.fn() })).rejects.toThrow(
      'own account'
    );
    expect(h.release).not.toHaveBeenCalled();
  });

  it('audits a paid release with the credits, the reason and the held-grant source', async () => {
    const res = { json: vi.fn() };
    await h.handler!(request(), res);

    expect(h.release).toHaveBeenCalledExactlyOnceWith('user-1', h.adapters);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.credits.adjusted',
        target: { kind: 'user', id: 'user-1', displayName: 'user@example.com' },
        reason: 'Support approved request',
        details: { credits: 10, source: 'held_grant_release' },
      })
    );
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ outcome: 'applied', credits: 10 });
  });

  it('writes no audit entry for a no-op and answers with its reason', async () => {
    h.release.mockResolvedValue({ outcome: 'noop', reason: 'not_held' });
    const res = { json: vi.fn() };

    await h.handler!(request(), res);

    expect(h.audit).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ outcome: 'noop', reason: 'not_held' });
  });

  it('does not pay or audit when reading the target fails', async () => {
    h.findById.mockRejectedValueOnce(new Error('lookup unavailable'));

    await expect(h.handler!(request(), { json: vi.fn() })).rejects.toThrow('lookup unavailable');

    expect(h.release).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('still answers a paid release when the audit write fails, and logs it', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));
    const res = { json: vi.fn() };

    await h.handler!(request(), res);

    expect(res.json).toHaveBeenCalledExactlyOnceWith({ outcome: 'applied', credits: 10 });
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });
});
