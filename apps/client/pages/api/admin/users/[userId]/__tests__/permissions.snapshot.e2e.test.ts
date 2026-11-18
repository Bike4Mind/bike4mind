import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { AdminAuditLogModel, AdminRoleModel, User, adminRoleRepository, mongoose } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { adminRolesDeps } from '@server/admin/adminRoles/adapters';
import { updateAdminRole } from '@server/admin/adminRoles/adminRoles';

const controls = vi.hoisted(() => ({
  handler: undefined as ((req: Request, res: Response) => Promise<unknown>) | undefined,
  stepUp: vi.fn(),
  failAfterAudit: false,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: () => chain,
      put: (handler: (req: Request, res: Response) => Promise<unknown>) => {
        controls.handler = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => {} }));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: controls.stepUp }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => {
  const original = await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>();
  return {
    ...original,
    recordAdminActionFromRequest: async (...args: Parameters<typeof original.recordAdminActionFromRequest>) => {
      const result = await original.recordAdminActionFromRequest(...args);
      if (controls.failAfterAudit) throw new Error('strict audit failure');
      return result;
    },
  };
});
await import('../permissions');

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const ADMIN = '650000000000000000000009';
const TARGET = '650000000000000000000001';
let mongoServer: Awaited<ReturnType<typeof createMongoReplSet>>;
const actor = { id: ADMIN, name: 'Reviewer', username: 'reviewer', isAdmin: true };

const deferred = () => {
  let releasePromise: (() => void) | undefined;
  const promise = new Promise<void>(release => {
    releasePromise = release;
  });
  return {
    promise,
    resolve: () => {
      if (!releasePromise) throw new Error('Deferred promise was not initialized');
      releasePromise();
    },
  };
};
const request = (url: string, body: unknown = {}) => {
  const mocks = createMocks({ method: 'PUT', url, query: { userId: TARGET } });
  mocks.req.body = body;
  return {
    req: Object.assign(mocks.req, { user: actor }) as unknown as Request,
    res: mocks.res as unknown as Response,
  };
};
const removeRole = async (roleId: string) => {
  const { req, res } = request(`/api/admin/users/${TARGET}/permissions`, {
    before: [],
    adminPermissions: [],
    beforeAdminRoleIds: [roleId],
    adminRoleIds: [],
    reason: 'No longer on the team',
  });
  if (!controls.handler) throw new Error('Permissions handler was not registered');
  await controls.handler(req, res);
};
const seed = async () => {
  controls.stepUp.mockReset().mockResolvedValue(undefined);
  const role = await adminRoleRepository.create({
    name: 'Reviewer role',
    description: '',
    permissions: ['credits:adjust'],
    createdBy: ADMIN,
  });
  await User.collection.insertOne({
    _id: new mongoose.Types.ObjectId(TARGET),
    name: 'Target',
    username: 'target',
    isAdmin: false,
    adminPermissions: [],
    adminRoleIds: [new mongoose.Types.ObjectId(role.id)],
  });
  return role;
};

beforeAll(async () => {
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterEach(async () => {
  controls.failAfterAudit = false;
  await Promise.all([User.deleteMany({}), AdminRoleModel.deleteMany({}), AdminAuditLogModel.collection.deleteMany({})]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('permission-removal snapshot transaction', () => {
  it('retries against a concurrent role edit and audits the permissions actually removed', async () => {
    const role = await seed();
    const paused = deferred();
    const resume = deferred();
    controls.stepUp.mockImplementationOnce(async () => {
      paused.resolve();
      await resume.promise;
    });
    const removal = removeRole(role.id);
    let editedSnapshot: { __v: number; updatedAt: Date } | null = null;
    try {
      await paused.promise;
      const { req } = request(`/api/admin/admin-roles/${role.id}`);
      await updateAdminRole(
        actor,
        role.id,
        { permissions: ['users:moderate'], reason: 'Narrow the role to moderation' },
        adminRolesDeps(req)
      );
      editedSnapshot = await AdminRoleModel.findById(role.id).lean<{ __v: number; updatedAt: Date }>();
    } finally {
      resume.resolve();
    }
    await removal;
    expect(await User.findById(TARGET).select('adminRoleIds').lean()).toMatchObject({ adminRoleIds: [] });
    const audit = await AdminAuditLogModel.findOne({ action: 'user.permissions.updated' }).lean();
    expect(audit?.details?.removedRolePermissions).toEqual([
      { roleId: role.id, permissions: ['users:moderate'], roleName: 'Reviewer role' },
    ]);
    if (!editedSnapshot) throw new Error('Edited role snapshot was not captured');
    const finalRole = await AdminRoleModel.findById(role.id).lean<{ __v: number; updatedAt: Date }>();
    expect(finalRole?.__v).toBe(editedSnapshot.__v + 1);
    expect(finalRole?.updatedAt).toEqual(editedSnapshot.updatedAt);
  });

  it('rolls back the user, role fence and inserted audit when strict auditing fails', async () => {
    const role = await seed();
    const before = await AdminRoleModel.findById(role.id).lean<{ __v: number; updatedAt: Date }>();
    controls.failAfterAudit = true;
    await expect(removeRole(role.id)).rejects.toThrow('strict audit failure');
    const after = await AdminRoleModel.findById(role.id).lean<{ __v: number; updatedAt: Date }>();
    expect(after?.__v).toBe(before?.__v);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    const target = await User.findById(TARGET).select('adminRoleIds').lean();
    expect(target?.adminRoleIds?.map(String)).toEqual([role.id]);
    expect(await AdminAuditLogModel.countDocuments({ action: 'user.permissions.updated' })).toBe(0);
  });
});
