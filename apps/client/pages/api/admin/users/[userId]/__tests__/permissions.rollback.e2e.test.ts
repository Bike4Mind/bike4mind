// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { User } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method: string }, res: unknown) => handlers[req.method]?.(req, res), {
      use: () => chain,
      put: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.PUT = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: vi.fn(async () => undefined) }));

const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@server/utils/adminAudit', async original => ({
  ...(await original<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: mocks.record,
}));

import handler from '../permissions';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  vi.clearAllMocks();
  await mongoose.connection.dropDatabase();
});

const actorId = new mongoose.Types.ObjectId().toString();

const seedTarget = async () => {
  const targetId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: targetId,
    username: 'target',
    name: 'Target',
    isAdmin: false,
    adminPermissions: ['support:read'],
  });
  return targetId.toString();
};

const readGrants = async (userId: string) => {
  const doc = await User.findById(userId).select('isAdmin adminPermissions').lean();
  return { isAdmin: doc?.isAdmin, adminPermissions: doc?.adminPermissions };
};

const put = (userId: string, body: object) => {
  const { req, res } = createMocks({ method: 'PUT', query: { userId }, body });
  (req as unknown as { user: { id: string; isAdmin: boolean } }).user = { id: actorId, isAdmin: true };
  return (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
};

const grantBody = { isAdmin: true, adminPermissions: ['support:read', 'settings:manage'], reason: 'Promote' };

describe('PUT /api/admin/users/[userId]/permissions grant persistence', () => {
  it('rolls the grants back when the strict audit write fails', async () => {
    const userId = await seedTarget();
    mocks.record.mockRejectedValueOnce(new Error('audit down'));

    await expect(put(userId, grantBody)).rejects.toThrow('audit down');

    expect(await readGrants(userId)).toEqual({ isAdmin: false, adminPermissions: ['support:read'] });
  });

  it('persists the grants when the audit write succeeds', async () => {
    const userId = await seedTarget();
    mocks.record.mockResolvedValueOnce(undefined);

    await put(userId, grantBody);

    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(await readGrants(userId)).toEqual({ isAdmin: true, adminPermissions: ['support:read', 'settings:manage'] });
  });
});
