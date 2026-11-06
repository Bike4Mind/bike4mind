import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Permission, KnowledgeType } from '@bike4mind/common';
import { User, Project, FabFile, projectRepository, fabFileRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';

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
vi.mock('@bike4mind/server-utils/utils/analyticsLog', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/analyticsLog')>();
  return { ...actual, logEvent: vi.fn(actual.logEvent) };
});

let replSet: MongoMemoryReplSet;
let deleteHandler: Handler;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  // Nothing here depends on an index, so skip the build storm rather than wait it out.
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await import('../members');
  await settleAutoIndexBuilds(mongoose);
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

describe('DELETE /api/projects/[id]/members - pinned files the leaver can no longer read (real DB)', () => {
  // What accept.ts mints when a file is added to a project: a projectId-tagged grant per participant.
  const projectGrant = (userId: string, projectId: string) => ({
    userId,
    permissions: [Permission.read, Permission.update],
    projectId,
  });
  const pin = (userId: string, fileId: string) =>
    User.updateOne({ _id: userId }, { $set: { systemFiles: [{ fileId, enabled: true }] } });
  const pinned = async (userId: string) => ((await User.findById(userId).lean())?.systemFiles ?? []).map(f => f.fileId);

  const seedProjectFiles = async () => {
    const { owner, member, projectId } = await seed();
    const stayer = await User.create({
      name: 'Stayer',
      username: `stayer-${Math.random().toString(36).slice(2, 10)}`,
      password: null,
      hasUsablePassword: false,
    });
    await Project.updateOne(
      { _id: projectId },
      { $push: { users: { userId: stayer.id, permissions: [Permission.read, Permission.update] } } }
    );
    const ownerFile = await FabFile.create({
      userId: owner.id,
      fileName: 'owner.md',
      type: KnowledgeType.FILE,
      users: [projectGrant(member.id, projectId), projectGrant(stayer.id, projectId)],
    });
    const memberFile = await FabFile.create({
      userId: member.id,
      fileName: 'member.md',
      type: KnowledgeType.FILE,
      users: [projectGrant(stayer.id, projectId)],
    });
    await Project.updateOne({ _id: projectId }, { $set: { fileIds: [ownerFile.id, memberFile.id] } });
    await pin(member.id, ownerFile.id);
    await pin(stayer.id, memberFile.id);
    return { owner, member, stayer, projectId, ownerFile, memberFile };
  };

  it("a member leaving loses the project's files from their pins, and the others lose the leaver's files", async () => {
    const { member, stayer, projectId } = await seedProjectFiles();
    const { req, res } = request(member, projectId);

    await deleteHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(await pinned(member.id)).toEqual([]);
    expect(await pinned(stayer.id)).toEqual([]);
  });

  it('keeps a pin the leaver can still read through another grant', async () => {
    const { owner, member, projectId, ownerFile } = await seedProjectFiles();
    await FabFile.updateOne({ _id: ownerFile.id }, { $set: { isGlobalRead: true } });
    const { req, res } = request(owner, projectId, { userId: member.id });

    await deleteHandler(req, res);

    expect(await pinned(member.id)).toEqual([ownerFile.id]);
  });

  it('cleans nothing when the leave is rolled back', async () => {
    const { owner, member, projectId, ownerFile } = await seedProjectFiles();
    vi.mocked(logEvent).mockRejectedValueOnce(new Error('post-update failure'));
    const { req, res } = request(owner, projectId, { userId: member.id });

    await expect(deleteHandler(req, res)).rejects.toThrow('post-update failure');

    expect(await pinned(member.id)).toEqual([ownerFile.id]);
  });

  it("drops the owner's pin on the leaver's file once the owner's project grant is revoked", async () => {
    const { owner, member, projectId, memberFile } = await seedProjectFiles();
    await FabFile.updateOne({ _id: memberFile.id }, { $push: { users: projectGrant(owner.id, projectId) } });
    await pin(owner.id, memberFile.id);
    const { req, res } = request(member, projectId);

    await deleteHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(await pinned(owner.id)).toEqual([]);
  });
});

describe("DELETE /api/projects/[id]/members - the owner's grant on a departing member's documents (real DB)", () => {
  const addOwnFileAsMember = async (member: { id: string }, projectId: string) => {
    const file = await FabFile.create({ userId: member.id, fileName: 'member.md', type: KnowledgeType.FILE });
    const memberDoc = await User.findById(member.id);
    // The real add path: it is what grants the project owner access to a member's file.
    await projectService.addFiles(memberDoc!.toJSON() as never, { projectId, fileIds: [file.id] }, {
      db: { projects: projectRepository, fabFiles: fabFileRepository },
    } as never);
    return file;
  };
  const canRead = async (user: { id: string }, fileId: string) =>
    !!(await fabFileRepository.shareable.findAccessibleById({ id: user.id, groups: [] } as never, fileId));

  it.each([
    ['leaves', (member: { id: string }) => member, {}],
    ['is removed by the owner', (_member: { id: string }, owner: { id: string }) => owner, 'remove'],
  ] as const)("the owner loses access to the member's file when the member %s", async (_label, actorOf, mode) => {
    const { owner, member, projectId } = await seed();
    // A second member, so the cascade writes the same file twice in one transaction: once for the
    // owner's grant, then for theirs.
    const stayer = await User.create({
      name: 'Stayer',
      username: `stayer-${Math.random().toString(36).slice(2, 10)}`,
      password: null,
      hasUsablePassword: false,
    });
    await Project.updateOne(
      { _id: projectId },
      { $push: { users: { userId: stayer.id, permissions: [Permission.read, Permission.update] } } }
    );
    const file = await addOwnFileAsMember(member, projectId);
    expect(await canRead(owner, file.id)).toBe(true);
    expect(await canRead(stayer, file.id)).toBe(true);

    const { req, res } = request(actorOf(member, owner), projectId, mode === 'remove' ? { userId: member.id } : {});
    await deleteHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(await canRead(owner, file.id)).toBe(false);
    expect(await canRead(stayer, file.id)).toBe(false);
    expect((await Project.findById(projectId))?.fileIds).toEqual([]);
  });
});
