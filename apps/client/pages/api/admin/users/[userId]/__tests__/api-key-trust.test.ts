import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  guard: null as null | ((req: unknown, res: unknown, next: () => void) => void),
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    const chain = {
      use: (guard: unknown) => {
        h.guard ??= guard as typeof h.guard;
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

await import('../api-key-trust');

const REASON = 'Verified the integration owner';

const makeReq = (
  body: unknown,
  isAdmin = true,
  user: Record<string, unknown> = { id: 'admin-1', username: 'admin', isAdmin }
) => ({
  method: 'POST',
  query: { userId: 'user-1' },
  body,
  user,
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

// Runs the permission guard adminApi installs, then the handler, as the router would.
const guarded = async (req: Parameters<NonNullable<typeof h.handler>>[0]) => {
  h.guard!(req, {}, () => {});
  return h.handler!(req, { json: vi.fn() });
};
const delegate = (adminPermissions: string[]) => ({ id: 'admin-1', username: 'd', isAdmin: false, adminPermissions });

describe('POST /api/admin/users/[userId]/api-key-trust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a non-admin before touching the user', async () => {
    expect(h.config).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    await expect(guarded(makeReq({ approved: true }, false))).rejects.toThrow(/Missing permission: keys:revoke/);

    expect(h.findById).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('approves an untrusted user and audits the change', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@b.test', apiKeyTrustApproved: false });
    const json = vi.fn();

    await h.handler!(makeReq({ approved: true, reason: REASON }), { json });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', apiKeyTrustApproved: true });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.api_key_trust.approved',
        reason: REASON,
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        changes: [{ field: 'apiKeyTrustApproved', before: false, after: true }],
      })
    );
    expect(json).toHaveBeenCalledWith({ apiKeyTrustApproved: true });
  });

  it('revokes a trusted user and audits the change', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', apiKeyTrustApproved: true });
    const json = vi.fn();

    await h.handler!(makeReq({ approved: false, reason: REASON }), { json });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', apiKeyTrustApproved: false });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.api_key_trust.revoked',
        reason: REASON,
        changes: [{ field: 'apiKeyTrustApproved', before: true, after: false }],
      })
    );
    expect(json).toHaveBeenCalledWith({ apiKeyTrustApproved: false });
  });

  it('treats a missing flag as untrusted, so revoking is a no-op', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u' });
    const json = vi.fn();

    await h.handler!(makeReq({ approved: false, reason: REASON }), { json });

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ apiKeyTrustApproved: false });
  });

  it.each([{}, { approved: 'yes' }, null])('rejects an invalid body %j', async body => {
    await expect(h.handler!(makeReq(body), { json: vi.fn() })).rejects.toThrow(/invalid request body/i);

    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ approved: true }, /outdated version/],
    [{ approved: true, reason: 'no' }, /at least/i],
  ])('rejects a missing or too-short reason %j with no write and no audit', async (body, message) => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', apiKeyTrustApproved: false });

    await expect(h.handler!(makeReq(body), { json: vi.fn() })).rejects.toThrow(message);

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  describe('delegated admins', () => {
    it('refuses a delegate without keys:revoke before touching the user', async () => {
      const req = makeReq({ approved: true, reason: REASON }, false, delegate(['support:read']));
      await expect(guarded(req)).rejects.toMatchObject({ statusCode: 403 });
      expect(h.findById).not.toHaveBeenCalled();
    });

    it('lets a delegate with keys:revoke change trust on a non-admin user', async () => {
      h.findById.mockResolvedValue({ id: 'user-1', username: 'u', apiKeyTrustApproved: false });
      await guarded(makeReq({ approved: true, reason: REASON }, false, delegate(['keys:revoke'])));
      expect(h.update).toHaveBeenCalledWith({ id: 'user-1', apiKeyTrustApproved: true });
    });

    it('refuses a delegate on an admin user without writing', async () => {
      h.findById.mockResolvedValue({ id: 'user-1', username: 'u', isAdmin: true });
      const req = makeReq({ approved: true, reason: REASON }, false, delegate(['keys:revoke']));
      await expect(guarded(req)).rejects.toMatchObject({ statusCode: 403 });
      expect(h.update).not.toHaveBeenCalled();
      expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    });
  });
});
