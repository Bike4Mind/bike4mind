import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ForbiddenError,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionId,
  type AdminPermissionRequirement,
} from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type AdminIdentity = { isAdmin?: boolean; adminPermissions?: AdminPermissionId[] };

const h = vi.hoisted(() => ({
  options: null as unknown,
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  update: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: Partial<Record<string, AdminPermissionRequirement>> }) => {
    h.options = options;
    const gated = (method: string, fn: Handler): Handler => {
      return async (req, res) => {
        const requirement = options.adminPermissions[method];
        if (requirement && !meetsAdminPermissionRequirement((req as { user?: AdminIdentity }).user, requirement)) {
          throw new ForbiddenError(missingAdminPermissionMessage(requirement));
        }
        return fn(req, res);
      };
    };
    const chain = {
      use: () => chain,
      post: (fn: Handler) => {
        h.handler = gated('POST', fn);
        return chain;
      },
    };
    return chain;
  },
}));

vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, update: h.update },
  // Resolves the callback then records the commit, so a test can pin the grants AFTER the commit
  // rather than merely after the write inside the callback.
  withTransaction: async (fn: () => Promise<unknown>) => {
    const result = await fn();
    h.commit();
    return result;
  },
}));
const mockApplyGrants = vi.hoisted(() => vi.fn());
vi.mock('@server/auth/emailVerifiedGrants', () => ({
  applyEmailVerifiedGrants: (...a: unknown[]) => mockApplyGrants(...a),
}));
const mockEmitVerifiedFunnel = vi.hoisted(() => vi.fn());
vi.mock('@server/analytics/funnel', () => ({
  emitEmailVerifiedFunnelEvents: (...a: unknown[]) => mockEmitVerifiedFunnel(...a),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

await import('../verify-email');

const REASON = 'Support ticket confirmed the address';

const makeReq = (body: unknown = { reason: REASON }) => ({
  query: { userId: 'user-1' },
  body,
  user: { id: 'admin-1', username: 'admin', isAdmin: true },
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

describe('POST /api/admin/users/[userId]/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyGrants.mockResolvedValue({ creditsGranted: 100, subscriptionCreditsGranted: 20 });
  });

  it('writes exactly the verification fields, clearing the single-use token', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', emailVerified: false, email: 'a@b.test' });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.verified',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        reason: REASON,
      })
    );
    expect(h.update).toHaveBeenCalledWith({
      id: 'user-1',
      emailVerified: true,
      emailVerifiedAt: expect.any(Date),
      emailVerificationToken: null,
      emailVerificationExpires: null,
      emailVerificationSentAt: null,
    });
    expect(json).toHaveBeenCalledWith({ message: 'Email verified successfully' });
  });

  it('reports email_verified with the plan credits included in the amount', async () => {
    const user = { id: 'user-1', username: 'u', emailVerified: false, email: 'a@b.test' };
    h.findById.mockResolvedValue(user);

    await h.handler!(makeReq(), { json: vi.fn() });

    expect(mockEmitVerifiedFunnel).toHaveBeenCalledWith({ user, method: 'admin', creditsGranted: 120 });
  });

  it('applies the email-verified grants after the verification write', async () => {
    const user = { id: 'user-1', username: 'u', emailVerified: false, email: 'a@b.test' };
    h.findById.mockResolvedValue(user);
    const req = makeReq();

    await h.handler!(req, { json: vi.fn() });

    expect(mockApplyGrants).toHaveBeenCalledTimes(1);
    expect(mockApplyGrants).toHaveBeenCalledWith({
      user,
      verifiedEmail: 'a@b.test',
      trigger: 'admin-verification',
      releaseReason: 'admin verified email',
      logger: req.logger,
    });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(mockApplyGrants.mock.invocationCallOrder[0]);
    // Grants run after the commit, not inside the callback's transaction.
    expect(h.commit.mock.invocationCallOrder[0]).toBeLessThan(mockApplyGrants.mock.invocationCallOrder[0]);
  });

  it('skips the grants for a user without an email', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', emailVerified: false });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(mockApplyGrants).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ message: 'Email verified successfully' });
  });

  it('does not write an already-verified user', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', emailVerified: true });
    const json = vi.fn();

    await h.handler!(makeReq(), { json });

    expect(h.update).not.toHaveBeenCalled();
    expect(mockApplyGrants).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ alreadyVerified: true }));
  });

  it.each([
    [{}, /outdated version/],
    [{ reason: 'no' }, /at least/i],
  ])('rejects a missing or too-short reason %j with no write and no audit', async (body, message) => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', emailVerified: false, email: 'a@b.test' });

    await expect(h.handler!(makeReq(body), { json: vi.fn() })).rejects.toThrow(message);

    expect(h.update).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('declares users:moderate for POST', () => {
    expect(h.options).toEqual(expect.objectContaining({ adminPermissions: { POST: 'users:moderate' } }));
  });

  it('refuses a delegate without users:moderate before reading the user', async () => {
    const req = {
      ...makeReq(),
      user: { id: 'mod-1', username: 'mod', isAdmin: false, adminPermissions: ['support:read'] },
    };

    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow(missingAdminPermissionMessage('users:moderate'));
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a full administrator', { isAdmin: true }],
    ['a delegate with admin permissions', { adminPermissions: ['support:read'] }],
  ])('refuses a users:moderate delegate acting on %s', async (_label, adminFields) => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      emailVerified: false,
      email: 'a@b.test',
      ...adminFields,
    });
    const req = {
      ...makeReq(),
      user: { id: 'mod-1', username: 'mod', isAdmin: false, adminPermissions: ['users:moderate'] },
    };

    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow(
      'Only full administrators can verify the email of users with admin access'
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it('lets a delegate act on an ordinary user and a full admin act on an admin user', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', emailVerified: false, email: 'a@b.test' });
    await h.handler!(
      { ...makeReq(), user: { id: 'mod-1', username: 'mod', isAdmin: false, adminPermissions: ['users:moderate'] } },
      { json: vi.fn() }
    );
    h.findById.mockResolvedValue({
      id: 'user-2',
      username: 'a',
      isAdmin: true,
      emailVerified: false,
      email: 'c@d.test',
    });
    await h.handler!(makeReq(), { json: vi.fn() });

    expect(h.update).toHaveBeenCalledTimes(2);
  });
});
