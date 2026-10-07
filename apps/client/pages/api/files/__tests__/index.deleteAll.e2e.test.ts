import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { KnowledgeType, Permission } from '@bike4mind/common';
import { FabFile, User } from '@bike4mind/database';
import defineAbilitiesFor from '@server/auth/ability';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// DELETE /api/files against a real database (transactions need a replica set) with the real CASL
// scope: the caller's grant must also leave a share that is already soft-deleted, or undeleting it
// hands the access back. index.test.ts only pins that includeDeleted is passed to a mock.

type Handler = (req: unknown, res: unknown) => unknown;
interface BaseApiChain {
  get: (fn: Handler) => BaseApiChain;
  delete: (fn: Handler) => BaseApiChain;
}

const mockRefs = vi.hoisted(() => ({ deleteHandler: null as null | Handler }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: BaseApiChain = {
    get: () => chain,
    delete: fn => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await import('../index');
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const createUser = (name: string) =>
  User.create({
    name,
    username: `${name}-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
  });

describe('DELETE /api/files (real mongod)', () => {
  it('removes the caller from a soft-deleted file shared with them and leaves it deleted', async () => {
    const [caller, owner] = await Promise.all([createUser('caller'), createUser('owner')]);
    const shared = await FabFile.create({
      userId: owner.id,
      fileName: 'shared.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      users: [{ userId: caller.id, permissions: [Permission.read, Permission.delete] }],
    });
    await FabFile.deleteOne({ _id: shared._id });

    const { req, res } = createMocks({ method: 'DELETE' });
    Object.assign(req, {
      user: caller,
      ability: defineAbilitiesFor(caller),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    });
    await mockRefs.deleteHandler!(req, res);

    expect(res._getStatusCode()).toBe(204);
    const raw = await FabFile.collection.findOne({ _id: shared._id });
    expect(raw?.deletedAt).toBeInstanceOf(Date);
    expect(raw?.users).toEqual([]);
  });
});
