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
  countAdmins: vi.fn(),
  audit: vi.fn(),
  deny: vi.fn(),
  stepUp: vi.fn(),
  txn: { running: false },
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
  csrfProtection: () => (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: mocks.stepUp }));
vi.mock('@bike4mind/database', () => ({
  User: { findById: mocks.findById, updateOne: mocks.update, countDocuments: mocks.countAdmins },
  withTransaction: async (fn: () => Promise<unknown>) => {
    mocks.txn.running = true;
    try {
      return await fn();
    } finally {
      mocks.txn.running = false;
    }
  },
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
await import('../role');

const ADMIN = '650000000000000000000009';
const TARGET = '650000000000000000000001';
const REASON = 'Joined the admin team';

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

const targetWrites = () => mocks.update.mock.calls.filter(([filter]) => filter._id === TARGET);

beforeEach(() => {
  vi.clearAllMocks();
  target({ isAdmin: false });
  mocks.update.mockResolvedValue({ matchedCount: 1 });
  mocks.countAdmins.mockResolvedValue(3);
  mocks.audit.mockResolvedValue({});
  mocks.stepUp.mockResolvedValue(undefined);
  mocks.deny.mockImplementation(async () => {
    throw Object.assign(new Error('denied'), { statusCode: 403 });
  });
});

describe('PUT /api/admin/users/:userId/role', () => {
  it('is session-only and PUT-only', () => {
    expect(mocks.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['PUT'] });
  });

  it.each([
    ['grants', false, true, 'user.role.admin_granted', 'granted the admin role'],
    ['revokes', true, false, 'user.role.admin_revoked', 'revoked the admin role'],
  ])('%s the role behind step-up with a strict, reasoned audit entry', async (_l, before, after, action, summary) => {
    target({ isAdmin: before });
    let auditedInsideTransaction = false;
    mocks.audit.mockImplementation(async () => {
      auditedInsideTransaction = mocks.txn.running;
      return {};
    });
    const res = await call({ isAdmin: after, reason: `  ${REASON}  ` });

    expect(res._getJSONData()).toEqual({ isAdmin: after });
    expect(mocks.stepUp).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith(
      { _id: TARGET, isAdmin: after ? { $ne: true } : true },
      { $set: { isAdmin: after } },
      { runValidators: true }
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action,
        summary,
        reason: REASON,
        target: { kind: 'user', id: TARGET, displayName: 'Ada' },
        changes: [{ field: 'isAdmin', before, after }],
      })
    );
    expect(auditedInsideTransaction).toBe(true);
  });

  it("writes the actor's own row first, so two admins demoting each other collide in the transaction", async () => {
    target({ isAdmin: true });
    await call({ isAdmin: false, reason: REASON });

    expect(mocks.update.mock.calls[0]).toEqual([
      { _id: ADMIN, isAdmin: true },
      { $set: { updatedAt: expect.any(Date) } },
    ]);
    expect(targetWrites()).toHaveLength(1);
  });

  it('refuses an actor whose admin role is gone by the time the transaction runs', async () => {
    target({ isAdmin: true });
    mocks.update.mockResolvedValueOnce({ matchedCount: 0 });

    await expect(call({ isAdmin: false, reason: REASON })).rejects.toMatchObject({ statusCode: 403 });
    expect(targetWrites()).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  describe('lockout guard', () => {
    it('refuses to revoke the last remaining Super Admin, counted inside the transaction', async () => {
      target({ isAdmin: true });
      let countedInsideTransaction = false;
      mocks.countAdmins.mockImplementation(async () => {
        countedInsideTransaction = mocks.txn.running;
        return 1;
      });

      await expect(call({ isAdmin: false, reason: REASON })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/last remaining Super Admin/),
      });
      expect(mocks.countAdmins).toHaveBeenCalledWith({ isAdmin: true });
      expect(countedInsideTransaction).toBe(true);
      expect(targetWrites()).toHaveLength(0);
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('revokes a Super Admin who is not the last', async () => {
      target({ isAdmin: true });
      mocks.countAdmins.mockResolvedValue(2);

      const res = await call({ isAdmin: false, reason: REASON });
      expect(res._getJSONData()).toEqual({ isAdmin: false });
      expect(targetWrites()).toHaveLength(1);
    });

    it('does not count admins for a grant', async () => {
      await call({ isAdmin: true, reason: REASON });
      expect(mocks.countAdmins).not.toHaveBeenCalled();
    });
  });

  it('answers with the current role and writes nothing when the role already matches', async () => {
    target({ isAdmin: true });
    const res = await call({ isAdmin: true, reason: REASON });

    expect(res._getJSONData()).toEqual({ isAdmin: true });
    expect(mocks.stepUp).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('writes nothing when step-up is not satisfied', async () => {
    mocks.stepUp.mockRejectedValue(Object.assign(new Error('Recent verification required'), { statusCode: 403 }));

    await expect(call({ isAdmin: true, reason: REASON })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('answers 409 when the role changed under the request', async () => {
    target({ isAdmin: true });
    mocks.update.mockResolvedValueOnce({ matchedCount: 1 }).mockResolvedValueOnce({ matchedCount: 0 });

    await expect(call({ isAdmin: false, reason: REASON })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('fails the request when the audit write fails, so the transaction aborts', async () => {
    mocks.audit.mockRejectedValue(new Error('audit down'));
    await expect(call({ isAdmin: true, reason: REASON })).rejects.toThrow('audit down');
  });

  it.each([
    ['missing', undefined],
    ['too short', ' abc '],
  ])('answers 400 and writes nothing when the reason is %s', async (_label, reason) => {
    await expect(call({ isAdmin: true, reason })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 400 to a body without a boolean isAdmin', async () => {
    await expect(call({ isAdmin: 'yes', reason: REASON })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ['their own account', { id: TARGET, isAdmin: true }],
    ['the account they impersonate from', { id: '650000000000000000000002', isAdmin: true, impersonatedBy: TARGET }],
  ])('denies a role change on %s before the reason is checked', async (_label, actor) => {
    await expect(call({ isAdmin: false }, { actor })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.deny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.role.denied', attempted: 'user.role.admin_revoked' })
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses a delegated settings manager: the role stays with full admins', async () => {
    await expect(
      call({ isAdmin: true, reason: REASON }, { actor: { id: ADMIN, adminPermissions: ['settings:manage'] } })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('admits only settings:manage holders past the route guard', async () => {
    await expect(
      call({ isAdmin: true, reason: REASON }, { actor: { id: ADMIN, adminPermissions: ['support:read'] } })
    ).rejects.toThrow(/settings:manage/);
    expect(mocks.findById).not.toHaveBeenCalled();
  });
});
