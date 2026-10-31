// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

type Handler = (req: Request, res: Response) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, Handler>>,
  guards: {} as Record<string, (req: Request, res: Response, next: () => void) => void>,
  options: {} as Record<string, unknown>,
  adminPermissions: {} as Record<string, unknown>,
  txRuns: 0,
  findById: vi.fn(),
  update: vi.fn(),
  addMember: vi.fn(),
  revokeAccess: vi.fn(),
  audit: vi.fn(),
  keptShares: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: { allowedMethods: string[] }) => {
    const key = options.allowedMethods.join(',');
    mocks.options[key] = options;
    mocks.handlers[key] = {};
    const chain: Record<string, unknown> = {
      use: (guard: (req: Request, res: Response, next: () => void) => void) => {
        mocks.guards[key] = guard;
        return chain;
      },
    };
    for (const method of ['post', 'delete', 'patch']) {
      chain[method] = (fn: Handler) => {
        mocks.handlers[key][method.toUpperCase()] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@server/middlewares/adminApi', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/middlewares/adminApi')>();
  return {
    ...actual,
    adminApi: (options: { adminPermissions: Record<string, unknown> }) => {
      mocks.adminPermissions[Object.keys(options.adminPermissions).join(',')] = options.adminPermissions;
      return actual.adminApi(options as Parameters<typeof actual.adminApi>[0]);
    },
  };
});
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: mocks.findById, update: mocks.update },
  userRepository: {},
  groupRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  withTransaction: async (fn: () => Promise<unknown>) => {
    mocks.txRuns += 1;
    return fn();
  },
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { addMember: mocks.addMember, revokeAccess: mocks.revokeAccess },
}));
vi.mock('@bike4mind/server-utils/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEventSafe: mocks.logEvent }));
vi.mock('@server/utils/keptPersonalLakeSharesNotifier', () => ({
  reportAndNotifyKeptPersonalLakeShares: mocks.keptShares,
}));
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: mocks.audit,
    userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: 'ada@example.com' }),
  };
});

await import('../index');
await import('../[userId]');

const ORG = '650000000000000000000aaa';
const USER = '650000000000000000000001';
const OWNER = '650000000000000000000002';

const buildOrg = (overrides: Record<string, unknown> = {}) => ({
  id: ORG,
  name: 'Acme',
  userId: OWNER,
  seats: 10,
  adminUserIds: [] as string[],
  users: [{ userId: USER, permissions: ['read'] }],
  ...overrides,
});

const call = async (
  key: string,
  method: string,
  body: unknown,
  { isAdmin = true, permissions = [] as string[], userId = USER } = {}
) => {
  const { req, res } = createMocks({ method: method as 'POST', body, query: { id: ORG, userId } });
  const request = Object.assign(req, {
    user: { id: 'admin1', username: 'admin', isAdmin, adminPermissions: permissions },
    logger: { info: vi.fn(), error: vi.fn() },
  }) as unknown as Request;
  mocks.guards[key](request, res as unknown as Response, () => {});
  await mocks.handlers[key][method](request, res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.txRuns = 0;
  mocks.findById.mockResolvedValue(buildOrg());
  mocks.addMember.mockResolvedValue({ user: { id: USER, email: 'ada@example.com', level: 'PaidUser' } });
  mocks.revokeAccess.mockImplementation(async () => buildOrg({ users: [] }));
  mocks.audit.mockResolvedValue({});
  mocks.keptShares.mockResolvedValue(0);
});

describe('admin org membership routes', () => {
  it('declares first-party JWT-only authentication behind users:moderate', () => {
    expect(mocks.options.POST).toMatchObject({ auth: 'jwtOnly' });
    expect(mocks.options['DELETE,PATCH']).toMatchObject({ auth: 'jwtOnly' });
    expect(mocks.adminPermissions.POST).toEqual({ POST: 'users:moderate' });
    expect(mocks.adminPermissions['DELETE,PATCH']).toEqual({ DELETE: 'users:moderate', PATCH: 'users:moderate' });
  });

  describe('when the audit write fails', () => {
    beforeEach(() => {
      mocks.audit.mockRejectedValue(new Error('audit down'));
    });

    it.each([
      ['add', 'POST', 'POST', { userId: USER, reason: 'Customer request' }, buildOrg({ users: [] })],
      ['remove', 'DELETE,PATCH', 'DELETE', { reason: 'Left the team' }, buildOrg()],
      ['role change', 'DELETE,PATCH', 'PATCH', { role: 'manager', reason: 'Team lead changed' }, buildOrg()],
    ])('fails the %s from inside the transaction so it rolls back', async (_label, key, method, body, org) => {
      mocks.findById.mockResolvedValue(org);

      await expect(call(key, method, body)).rejects.toThrow('audit down');

      expect(mocks.txRuns).toBe(1);
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(mocks.keptShares).not.toHaveBeenCalled();
      expect(mocks.logEvent).not.toHaveBeenCalled();
    });
  });

  it('refuses a delegated admin, whose org authority the services do not recognise', async () => {
    mocks.findById.mockResolvedValue(buildOrg({ users: [] }));
    await expect(
      call(
        'POST',
        'POST',
        { userId: USER, reason: 'Customer request' },
        { isAdmin: false, permissions: ['users:moderate'] }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.addMember).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/organizations/[id]/members', () => {
  beforeEach(() => {
    mocks.findById.mockResolvedValue(buildOrg({ users: [] }));
  });

  it('requires a reason and writes nothing without one', async () => {
    await expect(call('POST', 'POST', { userId: USER })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.addMember).not.toHaveBeenCalled();
  });

  it('adds the user as a member and audits it against the user', async () => {
    const res = await call('POST', 'POST', { userId: USER, reason: 'Customer request' });

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({ organizationId: ORG, userId: USER, role: 'member' });
    expect(mocks.addMember).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin1' }),
      { organizationId: ORG, userId: USER },
      expect.anything()
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
      action: 'org.member.added',
      target: { kind: 'user', id: USER, displayName: 'ada@example.com' },
      organizationId: ORG,
      summary: 'added to organization Acme',
      reason: 'Customer request',
      details: { organizationName: 'Acme', role: 'member' },
    });
  });

  it('refuses with the seat message when the owner and members fill the paid seats', async () => {
    mocks.findById.mockResolvedValue(
      buildOrg({
        seats: 3,
        users: [
          { userId: 'a', permissions: ['read'] },
          { userId: 'b', permissions: ['read'] },
        ],
      })
    );
    await expect(call('POST', 'POST', { userId: USER, reason: 'Customer request' })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('Acme uses all 3 paid seats'),
    });
    expect(mocks.addMember).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['a member', buildOrg()],
    ['the owner', buildOrg({ userId: USER, users: [] })],
  ])('refuses to add %s again', async (_label, org) => {
    mocks.findById.mockResolvedValue(org);
    await expect(call('POST', 'POST', { userId: USER, reason: 'Customer request' })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.addMember).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/organizations/[id]/members/[userId]', () => {
  it('requires a reason and writes nothing without one', async () => {
    await expect(call('DELETE,PATCH', 'DELETE', {})).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.revokeAccess).not.toHaveBeenCalled();
  });

  it('blocks removing the owner', async () => {
    await expect(
      call('DELETE,PATCH', 'DELETE', { reason: 'Account cleanup' }, { userId: OWNER })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('transfer organization ownership') });
    expect(mocks.revokeAccess).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('returns 404 for someone not in the org', async () => {
    mocks.findById.mockResolvedValue(buildOrg({ users: [] }));
    await expect(call('DELETE,PATCH', 'DELETE', { reason: 'Account cleanup' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.revokeAccess).not.toHaveBeenCalled();
  });

  it('revokes access, audits the previous role and reports kept shares after the commit', async () => {
    mocks.findById.mockResolvedValue(buildOrg({ adminUserIds: [USER] }));
    const res = await call('DELETE,PATCH', 'DELETE', { reason: 'Left the team' });

    expect(mocks.revokeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin1' }),
      { id: ORG, userId: USER },
      expect.anything()
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.member.removed',
        target: expect.objectContaining({ kind: 'user', id: USER }),
        organizationId: ORG,
        reason: 'Left the team',
        details: { organizationName: 'Acme', role: 'manager' },
      })
    );
    expect(mocks.keptShares).toHaveBeenCalledWith(USER, expect.objectContaining({ id: ORG }), expect.anything());
    expect(res._getJSONData()).toEqual({ organizationId: ORG, userId: USER, personalLakeSharesKept: 0 });
  });
});

describe('PATCH /api/admin/organizations/[id]/members/[userId]', () => {
  it('requires a reason and writes nothing without one', async () => {
    await expect(call('DELETE,PATCH', 'PATCH', { role: 'manager' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('makes a member a manager and audits the role change', async () => {
    mocks.findById.mockResolvedValue(buildOrg({ adminUserIds: ['other'] }));
    const res = await call('DELETE,PATCH', 'PATCH', { role: 'manager', reason: 'Team lead changed' });

    expect(mocks.update).toHaveBeenCalledWith({ id: ORG, adminUserIds: ['other', USER] });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.member.role_changed',
        target: expect.objectContaining({ kind: 'user', id: USER }),
        organizationId: ORG,
        reason: 'Team lead changed',
        changes: [{ field: 'role', before: 'member', after: 'manager' }],
        details: { organizationName: 'Acme' },
      })
    );
    expect(res._getJSONData()).toEqual({ organizationId: ORG, userId: USER, role: 'manager' });
  });

  it('makes a manager a member again', async () => {
    mocks.findById.mockResolvedValue(buildOrg({ adminUserIds: [USER, 'other'] }));
    await call('DELETE,PATCH', 'PATCH', { role: 'member', reason: 'Team lead changed' });
    expect(mocks.update).toHaveBeenCalledWith({ id: ORG, adminUserIds: ['other'] });
  });

  it.each([
    ['the owner', OWNER, "The owner's role can't be changed."],
    ['an unchanged role', USER, 'already a member'],
  ])('refuses %s', async (_label, userId, message) => {
    await expect(
      call('DELETE,PATCH', 'PATCH', { role: 'member', reason: 'Team lead changed' }, { userId })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(message) });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('refuses to appoint a manager whose row confers no membership', async () => {
    mocks.findById.mockResolvedValue(buildOrg({ users: [{ userId: USER, permissions: [] }] }));
    await expect(call('DELETE,PATCH', 'PATCH', { role: 'manager', reason: 'Team lead changed' })).rejects.toMatchObject(
      { statusCode: 400 }
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
