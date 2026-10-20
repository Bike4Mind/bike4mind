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

const seedProject = (fileIds: string[], systemPrompts: string[]) => {
  seq += 1;
  return Project.create({
    name: `p${seq}`,
    userId: 'owner',
    fileIds,
    systemPrompts: systemPrompts.map(fileId => ({ fileId, enabled: true })),
  });
};
const projectRefsOf = async (id: string) => {
  const project = await Project.findById(id).lean();
  return { fileIds: project?.fileIds, systemPrompts: project?.systemPrompts?.map(prompt => prompt.fileId) };
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

describe('UserRepository.pullSystemFilesFromAllUsers', () => {
  it('removes the ids from every user holding them', async () => {
    const a = await seedUser([
      { fileId: 'f1', enabled: true },
      { fileId: 'keep', enabled: true },
    ]);
    const b = await seedUser([{ fileId: 'f1', enabled: false }]);

    await userRepository.pullSystemFilesFromAllUsers(['f1']);

    expect(await systemFileIdsOf(a.id)).toEqual(['keep']);
    expect(await systemFileIdsOf(b.id)).toEqual([]);
  });
});

describe('ProjectRepository.pullFileReferences', () => {
  it('removes the ids from fileIds and systemPrompts of the named project only', async () => {
    const target = await seedProject(['f1', 'keep'], ['f1', 'sp-keep']);
    const other = await seedProject(['f1'], ['f1']);

    await projectRepository.pullFileReferences(['f1'], target.id);

    expect(await projectRefsOf(target.id)).toEqual({ fileIds: ['keep'], systemPrompts: ['sp-keep'] });
    expect(await projectRefsOf(other.id)).toEqual({ fileIds: ['f1'], systemPrompts: ['f1'] });
  });

  it('removes the ids from every project when no project is named', async () => {
    const a = await seedProject(['f1', 'keep'], []);
    const b = await seedProject([], ['f1']);

    await projectRepository.pullFileReferences(['f1']);

    expect(await projectRefsOf(a.id)).toEqual({ fileIds: ['keep'], systemPrompts: [] });
    expect(await projectRefsOf(b.id)).toEqual({ fileIds: [], systemPrompts: [] });
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
    await userRepository.pullSystemFilesFromAllUsers([file.id]);
    await projectRepository.pullFileReferences([file.id], project.id);
    await projectRepository.pullFileReferences([file.id]);

    expect(await FabFile.findById(file.id).lean()).toEqual(before);
  });
});
