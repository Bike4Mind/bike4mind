import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from '../auth/UserModel';
import { Project, projectRepository } from './ProjectModel';
import { FabFile } from './FabFileModel';

// The reference-only $pulls behind the stale-attachment prune and the delete cascade: each must drop
// exactly the named ids from exactly the named scope, and never touch the file documents themselves.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await User.deleteMany({});
  await Project.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
  await FabFile.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

let seq = 0;
const seedUser = (systemFiles: { fileId: string; enabled: boolean }[]) => {
  seq += 1;
  return User.create({
    username: `u${seq}`,
    name: `U${seq}`,
    email: `u${seq}@example.com`,
    tokenVersion: 0,
    systemFiles,
  });
};
const systemFileIdsOf = async (id: string) =>
  ((await User.findById(id).lean())?.systemFiles ?? []).map(entry => entry.fileId);

const seedProject = (
  fileIds: string[],
  systemPrompts: string[],
  { userId = 'owner', sharedWith = [] as string[] } = {}
) => {
  seq += 1;
  return Project.create({
    name: `p${seq}`,
    userId,
    users: sharedWith.map(id => ({ userId: id, permissions: ['read'] })),
    fileIds,
    systemPrompts: systemPrompts.map(fileId => ({ fileId, enabled: true })),
  });
};
const projectRefsOf = async (id: string) => {
  const project = await Project.findById(id).lean();
  return { fileIds: project?.fileIds, systemPrompts: project?.systemPrompts?.map(prompt => prompt.fileId) };
};

const stagesOf = (plan: unknown): string[] => {
  if (!plan || typeof plan !== 'object') return [];
  const node = plan as Record<string, unknown>;
  return [
    ...(typeof node.stage === 'string' ? [node.stage] : []),
    ...Object.values(node).flatMap(value => (Array.isArray(value) ? value.flatMap(stagesOf) : stagesOf(value))),
  ];
};

describe('UserRepository.pullSystemFiles', () => {
  it("removes the ids from that user's system files, enabled or not, and no one else's", async () => {
    const target = await seedUser([
      { fileId: 'f1', enabled: true },
      { fileId: 'f2', enabled: false },
      { fileId: 'keep', enabled: true },
    ]);
    const other = await seedUser([{ fileId: 'f1', enabled: true }]);

    await userRepository.pullSystemFiles(target.id, ['f1', 'f2']);

    expect(await systemFileIdsOf(target.id)).toEqual(['keep']);
    expect(await systemFileIdsOf(other.id)).toEqual(['f1']);
  });
});

describe('UserRepository.pullSystemFilesForUsers', () => {
  it('removes the ids from the named users only, never from a user who merely holds the same id', async () => {
    const owner = await seedUser([
      { fileId: 'f1', enabled: true },
      { fileId: 'keep', enabled: true },
    ]);
    const recipient = await seedUser([{ fileId: 'f1', enabled: false }]);
    const neverShared = await seedUser([{ fileId: 'f1', enabled: true }]);

    await userRepository.pullSystemFilesForUsers([owner.id, recipient.id], ['f1']);

    expect(await systemFileIdsOf(owner.id)).toEqual(['keep']);
    expect(await systemFileIdsOf(recipient.id)).toEqual([]);
    expect(await systemFileIdsOf(neverShared.id)).toEqual(['f1']);
  });

  it('is a no-op for no users, no files, or malformed user ids', async () => {
    const user = await seedUser([{ fileId: 'f1', enabled: true }]);

    await userRepository.pullSystemFilesForUsers([], ['f1']);
    await userRepository.pullSystemFilesForUsers([user.id], []);
    await userRepository.pullSystemFilesForUsers(['not-an-id'], ['f1']);

    expect(await systemFileIdsOf(user.id)).toEqual(['f1']);
  });
});

describe('ProjectRepository.pullFileReferences', () => {
  it('removes the ids from fileIds and systemPrompts of the named project only', async () => {
    const target = await seedProject(['f1', 'keep'], ['f1', 'sp-keep']);
    const other = await seedProject(['f1'], ['f1']);

    await projectRepository.pullFileReferences(['f1'], { projectId: target.id });

    expect(await projectRefsOf(target.id)).toEqual({ fileIds: ['keep'], systemPrompts: ['sp-keep'] });
    expect(await projectRefsOf(other.id)).toEqual({ fileIds: ['f1'], systemPrompts: ['f1'] });
  });

  it('removes the ids from projects owned by or shared with the named users, and no others', async () => {
    const owned = await seedProject(['f1', 'keep'], [], { userId: 'holder' });
    const shared = await seedProject([], ['f1'], { userId: 'someone', sharedWith: ['holder'] });
    const unrelated = await seedProject(['f1'], ['f1'], { userId: 'stranger' });

    await projectRepository.pullFileReferences(['f1'], { userIds: ['holder'] });

    expect(await projectRefsOf(owned.id)).toEqual({ fileIds: ['keep'], systemPrompts: [] });
    expect(await projectRefsOf(shared.id)).toEqual({ fileIds: [], systemPrompts: [] });
    expect(await projectRefsOf(unrelated.id)).toEqual({ fileIds: ['f1'], systemPrompts: ['f1'] });
  });

  it('scopes the user-scoped write with indexes, never a collection scan', async () => {
    await Project.syncIndexes();
    await seedProject(['f1'], [], { userId: 'holder' });
    const updateMany = vi.spyOn(Project, 'updateMany');

    await projectRepository.pullFileReferences(['f1'], { userIds: ['holder'] });

    const filter = updateMany.mock.calls[0]?.[0];
    updateMany.mockRestore();
    expect(filter).toBeDefined();
    // Explains the captured filter exactly as sent, before any soft-delete-plugin hook: through
    // Project.find the plugin would add `deletedAt` and mask a filter that scans without it.
    const explained = (await Project.collection.find(filter!).explain('queryPlanner')) as unknown as {
      queryPlanner: { winningPlan: unknown };
    };
    const stages = stagesOf(explained.queryPlanner.winningPlan);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });
});

describe('reference pulls leave file documents alone', () => {
  it('does not delete or modify the file a reference points at', async () => {
    const file = await FabFile.create({
      userId: 'u-owner',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
    });
    const before = await FabFile.findById(file.id).lean();
    const user = await seedUser([{ fileId: file.id, enabled: true }]);
    const project = await seedProject([file.id], [file.id]);

    await userRepository.pullSystemFiles(user.id, [file.id]);
    await userRepository.pullSystemFilesForUsers([user.id], [file.id]);
    await projectRepository.pullFileReferences([file.id], { projectId: project.id });
    await projectRepository.pullFileReferences([file.id], { userIds: ['owner'] });

    expect(await FabFile.findById(file.id).lean()).toEqual(before);
  });
});
