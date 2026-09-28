import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Permission, KnowledgeType } from '@bike4mind/common';
import { User, Project, FabFile, projectRepository, fabFileRepository } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The repositories are process-wide singletons, so a session assigned to their `.txn` outlives the
// transaction and later writes fail with MongoExpiredSessionError. Transactions need a replica set.

type Handler = (req: unknown, res: unknown) => unknown;
interface BaseApiChain {
  delete: (fn: Handler) => BaseApiChain;
}

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | Handler,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: BaseApiChain = {
    delete: fn => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

// Wraps the real logEvent so case (c) below can force a rejection deep in the transaction without
// touching the DB-facing behavior the other cases rely on.
vi.mock('@server/utils/analyticsLog', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/analyticsLog')>();
  return { ...actual, logEvent: vi.fn(actual.logEvent) };
});

let replSet: MongoMemoryReplSet;
let deleteHandler: Handler;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await import('../members');
  deleteHandler = mockRefs.deleteHandler!;
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});

const seed = async () => {
  const [owner, member] = await Promise.all(
    ['Owner', 'Member'].map(name =>
      User.create({
        name,
        username: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`,
        password: null,
        hasUsablePassword: false,
      })
    )
  );
  const project = await Project.create({
    name: 'Shared project',
    description: 'd',
    userId: owner.id,
    users: [{ userId: member.id, permissions: [Permission.read, Permission.update] }],
    fileIds: [],
    sessionIds: [],
  });
  return { owner, member, projectId: String(project._id) };
};

const request = (actor: { id: string }, projectId: string, body: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: projectId }, body });
  (req as unknown as { user: { id: string } }).user = actor;
  (req as unknown as { ability: Record<string, unknown> }).ability = {};
  return { req, res };
};

// Writes, not reads: only the update paths in BaseModel.ts attach `_txn` to the query.
const probeRepositoriesForLeakedSession = async (owner: { id: string }) => {
  const project = await Project.create({ name: 'probe', description: 'd', userId: owner.id });
  const updatedProject = await projectRepository.update({ id: String(project._id), description: 'still alive' });
  expect(updatedProject?.description).toBe('still alive');

  const file = await FabFile.create({ userId: owner.id, fileName: 'probe.txt', type: KnowledgeType.FILE });
  const updatedFile = await fabFileRepository.update({ id: file.id, notes: 'still alive' });
  expect(updatedFile?.notes).toBe('still alive');
};

describe('DELETE /api/projects/[id]/members (real DB)', () => {
  it('a member leaving commits, and later repository writes do not inherit the ended session', async () => {
    const { owner, member, projectId } = await seed();
    const { req, res } = request(member, projectId);

    await deleteHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const project = await projectRepository.findById(projectId);
    expect(project?.users).toEqual([]);

    await probeRepositoriesForLeakedSession(owner);
  });

  it('an owner rejected from leaving their own project still leaves the repositories usable', async () => {
    const { owner, projectId } = await seed();
    const { req, res } = request(owner, projectId);

    await expect(deleteHandler(req, res)).rejects.toThrow('Project owner cannot leave their own project');

    await probeRepositoriesForLeakedSession(owner);
  });

  it('rolls back the member removal when a later step in the transaction rejects', async () => {
    const { owner, member, projectId } = await seed();
    vi.mocked(logEvent).mockRejectedValueOnce(new Error('post-update failure'));
    const { req, res } = request(owner, projectId, { userId: member.id });

    await expect(deleteHandler(req, res)).rejects.toThrow('post-update failure');

    const project = await Project.findById(projectId);
    expect(project?.users?.map(u => u.userId)).toEqual([member.id]);
  });
});
