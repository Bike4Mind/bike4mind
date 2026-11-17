import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

type Handler = (req: Request, res: Response) => Promise<unknown>;
type Guard = (req: Request, res: Response, next: () => void) => void;

const mocks = vi.hoisted(() => ({
  options: undefined as unknown,
  guards: [] as Guard[],
  handler: undefined as Handler | undefined,
  findById: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  deny: vi.fn(),
  stepUp: vi.fn(),
  findRoles: vi.fn(),
  csrfGuard: ((_req: unknown, _res: unknown, next: () => void) => next()) as Guard,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mocks.options = options;
    const chain = {
      use: (guard: Guard) => {
        mocks.guards.push(guard);
        return chain;
      },
      put: (fn: Handler) => {
        mocks.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => mocks.csrfGuard,
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: mocks.stepUp }));
vi.mock('@bike4mind/database', () => ({
  User: { findById: mocks.findById, updateOne: mocks.update },
  adminRoleRepository: { findByIds: mocks.findRoles },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  AdminUserNoteModel: {},
  AdminUserNoteRevisionModel: {},
  toAdminUserNote: vi.fn(),
  toAdminUserNoteRevision: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: mocks.audit,
  denySelfAdminAction: mocks.deny,
}));
await import('../permissions');

const ADMIN = '650000000000000000000009';
const TARGET = '650000000000000000000001';
const REASON = 'Joined the support rotation';
const SUPPORT_ROLE = '660000000000000000000001';
const BILLING_ROLE = '660000000000000000000002';
const ROLES: Record<string, { name: string; permissions: string[] }> = {
  [SUPPORT_ROLE]: { name: 'Support', permissions: ['support:read', 'users:moderate'] },
  [BILLING_ROLE]: { name: 'Billing', permissions: ['support:read', 'credits:adjust'] },
};

const target = (fields: Record<string, unknown>) =>
  mocks.findById.mockReturnValue({ select: () => ({ lean: async () => ({ name: 'Ada', ...fields }) }) });

const call = async (
  body: unknown,
  { actor = { id: ADMIN, isAdmin: true } as Record<string, unknown>, userId = TARGET } = {}
) => {
  const { req, res } = createMocks({ method: 'PUT', body, query: { userId } });
  const request = Object.assign(req, { user: actor }) as unknown as Request;
  for (const guard of mocks.guards) guard(request, res as unknown as Response, () => {});
  await mocks.handler!(request, res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  target({ isAdmin: false, adminPermissions: [] });
  mocks.update.mockResolvedValue({ matchedCount: 1 });
  mocks.audit.mockResolvedValue({});
  mocks.stepUp.mockResolvedValue(undefined);
  mocks.findRoles.mockImplementation(async (ids: string[]) =>
    ids.flatMap(id => (ROLES[id] ? [{ id, ...ROLES[id] }] : []))
  );
  mocks.deny.mockImplementation(async () => {
    throw Object.assign(new Error('denied'), { statusCode: 403 });
  });
});

describe('PUT /api/admin/users/:userId/permissions', () => {
  it('is session-only and PUT-only', () => {
    expect(mocks.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['PUT'] });
  });

  it('mounts csrf protection on the route', () => {
    expect(mocks.guards).toContain(mocks.csrfGuard);
  });

  it('admits only settings:manage holders past the route guard', async () => {
    await expect(
      call(
        { before: [], adminPermissions: ['support:read'], reason: REASON },
        { actor: { id: ADMIN, adminPermissions: ['support:read'] } }
      )
    ).rejects.toThrow(/settings:manage/);
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('grants and revokes in canonical order with a reasoned, attributed audit entry', async () => {
    target({ isAdmin: false, adminPermissions: ['users:moderate'] });
    const res = await call({
      before: ['users:moderate'],
      adminPermissions: ['credits:adjust', 'support:read'],
      reason: REASON,
    });

    expect(res._getJSONData()).toEqual({ adminPermissions: ['support:read', 'credits:adjust'], adminRoleIds: [] });
    expect(mocks.stepUp).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith(
      { _id: TARGET, adminPermissions: ['users:moderate'] },
      { $set: { adminPermissions: ['support:read', 'credits:adjust'] } },
      { runValidators: true }
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.permissions.updated',
        target: { kind: 'user', id: TARGET, displayName: 'Ada' },
        reason: REASON,
        changes: [{ field: 'adminPermissions', before: ['users:moderate'], after: ['support:read', 'credits:adjust'] }],
        details: {
          granted: ['support:read', 'credits:adjust'],
          revoked: ['users:moderate'],
          rolesAdded: [],
          rolesRemoved: [],
        },
      })
    );
  });

  it('matches an empty grant against a missing or empty field', async () => {
    await call({ before: [], adminPermissions: ['support:read'], reason: REASON });
    expect(mocks.update.mock.calls[0][0]).toEqual({ _id: TARGET, adminPermissions: { $in: [null, []] } });
  });

  it('cleans a stored set holding repeats or retired ids, matching the raw array it read', async () => {
    target({ isAdmin: false, adminPermissions: ['support:read', 'support:read', 'retired:perm'] });
    await call({ before: ['support:read'], adminPermissions: [], reason: REASON });
    expect(mocks.update).toHaveBeenCalledWith(
      { _id: TARGET, adminPermissions: ['support:read', 'support:read', 'retired:perm'] },
      { $set: { adminPermissions: [] } },
      { runValidators: true }
    );
    expect(mocks.audit.mock.calls[0][1].changes[0].before).toEqual(['support:read', 'support:read', 'retired:perm']);
  });

  it('rejects delegates, even ones holding settings:manage', async () => {
    await expect(
      call(
        { before: [], adminPermissions: ['support:read'], reason: REASON },
        { actor: { id: ADMIN, adminPermissions: ['settings:manage', 'support:read'] } }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('blocks an admin from changing their own permissions and records the attempt', async () => {
    await expect(
      call({ before: [], adminPermissions: ['support:read'], reason: REASON }, { userId: ADMIN })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.deny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.permissions.denied', attempted: 'user.permissions.updated' })
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('records a self-attempt even when the reason is missing', async () => {
    await expect(call({ before: [], adminPermissions: ['support:read'] }, { userId: ADMIN })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.deny).toHaveBeenCalledOnce();
  });

  it('blocks an impersonating admin from changing their own permissions', async () => {
    await expect(
      call(
        { before: [], adminPermissions: ['support:read'], reason: REASON },
        { actor: { id: TARGET, isAdmin: true, impersonatedBy: ADMIN }, userId: ADMIN }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.deny).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('never edits a full admin, so the last full admin cannot be demoted here', async () => {
    target({ isAdmin: true, adminPermissions: [] });
    await expect(call({ before: [], adminPermissions: [], reason: REASON })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('refuses to touch the full-admin flag', async () => {
    await expect(call({ before: [], adminPermissions: [], isAdmin: true, reason: REASON })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing reason', { before: [], adminPermissions: ['support:read'] }],
    ['a too-short reason', { before: [], adminPermissions: ['support:read'], reason: 'ok' }],
    ['an unknown permission', { before: [], adminPermissions: ['root'], reason: REASON }],
    ['a repeated permission', { before: [], adminPermissions: ['support:read', 'support:read'], reason: REASON }],
  ])('rejects %s', async (_label, body) => {
    await expect(call(body)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('reports a conflict when the stored set no longer matches what the editor loaded', async () => {
    target({ isAdmin: false, adminPermissions: ['keys:revoke'] });
    await expect(call({ before: [], adminPermissions: ['support:read'], reason: REASON })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('reports a conflict when a concurrent write lands first', async () => {
    mocks.update.mockResolvedValue({ matchedCount: 0 });
    await expect(call({ before: [], adminPermissions: ['support:read'], reason: REASON })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('writes nothing and skips step-up for an unchanged set', async () => {
    target({ isAdmin: false, adminPermissions: ['support:read'] });
    const res = await call({ before: ['support:read'], adminPermissions: ['support:read'], reason: REASON });
    expect(res._getJSONData()).toEqual({ adminPermissions: ['support:read'], adminRoleIds: [] });
    expect(mocks.stepUp).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('requires recent verification before writing', async () => {
    mocks.stepUp.mockRejectedValue(Object.assign(new Error('Recent verification required'), { statusCode: 403 }));
    await expect(call({ before: [], adminPermissions: ['support:read'], reason: REASON })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  describe('admin roles', () => {
    const roles = (beforeAdminRoleIds: string[], adminRoleIds: string[]) => ({
      before: [],
      adminPermissions: [],
      beforeAdminRoleIds,
      adminRoleIds,
      reason: REASON,
    });

    it('assigns a role with step-up, a guarded write and an audit entry naming the role', async () => {
      const res = await call(roles([], [SUPPORT_ROLE]));

      expect(res._getJSONData()).toEqual({ adminPermissions: [], adminRoleIds: [SUPPORT_ROLE] });
      expect(mocks.stepUp).toHaveBeenCalledOnce();
      const [filter, update] = mocks.update.mock.calls[0];
      expect(filter).toEqual({ _id: TARGET, adminPermissions: { $in: [null, []] }, adminRoleIds: { $in: [null, []] } });
      expect(update.$set.adminRoleIds.map(String)).toEqual([SUPPORT_ROLE]);
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.permissions.updated',
          summary: 'added to Support',
          changes: [{ field: 'adminRoleIds', before: [], after: [SUPPORT_ROLE] }],
          details: { granted: [], revoked: [], rolesAdded: ['Support'], rolesRemoved: [] },
        })
      );
    });

    it('removes a role, matching the stored membership', async () => {
      target({ isAdmin: false, adminPermissions: [], adminRoleIds: [SUPPORT_ROLE, BILLING_ROLE] });

      await call(roles([BILLING_ROLE, SUPPORT_ROLE], [BILLING_ROLE]));

      expect(mocks.update.mock.calls[0][0].adminRoleIds).toEqual([SUPPORT_ROLE, BILLING_ROLE]);
      expect(mocks.audit.mock.calls[0][1].details.rolesRemoved).toEqual(['Support']);
    });

    it('refuses an unknown role', async () => {
      await expect(call(roles([], ['660000000000000000000009']))).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it('reports a conflict when the stored roles no longer match what the editor loaded', async () => {
      target({ isAdmin: false, adminPermissions: [], adminRoleIds: [BILLING_ROLE] });
      await expect(call(roles([], [SUPPORT_ROLE]))).rejects.toMatchObject({ statusCode: 409 });
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it('refuses role assignment from a delegate, as the endpoint is full-admin only', async () => {
      await expect(
        call(roles([], [SUPPORT_ROLE]), { actor: { id: ADMIN, adminPermissions: ['settings:manage', 'support:read'] } })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it('requires both role fields together', async () => {
      await expect(
        call({ before: [], adminPermissions: [], adminRoleIds: [SUPPORT_ROLE], reason: REASON })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('leaves membership alone when the body names no roles', async () => {
      target({ isAdmin: false, adminPermissions: [], adminRoleIds: [SUPPORT_ROLE] });

      await call({ before: [], adminPermissions: ['keys:revoke'], reason: REASON });

      const [filter, update] = mocks.update.mock.calls[0];
      expect(filter).not.toHaveProperty('adminRoleIds');
      expect(update.$set).not.toHaveProperty('adminRoleIds');
    });

    it('refuses a role edit for a full admin target', async () => {
      target({ isAdmin: true, adminPermissions: [] });
      await expect(call(roles([], [SUPPORT_ROLE]))).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
