/**
 * Real-Mongo regression for the sharing flows' converted project writes (see
 * wholeDocUpdate.money.e2e.test.ts for the hazard). `addFiles` used to write the whole project it
 * read, so a share pushed onto `project.users` meanwhile was dropped, and a soft delete landing
 * meanwhile was undone by the snapshot's `deletedAt: null`.
 *
 * Consumes the built dist (`pnpm turbo:core:build`); integration lane only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, Project, fabFileRepository, projectRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { KnowledgeType, NotFoundError, Permission, type IUserDocument } from '@bike4mind/common';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([Project.deleteMany({}, { hardDelete: true }), FabFile.deleteMany({}, { hardDelete: true })]);
});

const OWNER = { id: 'owner', groups: [] } as unknown as IUserDocument;

/** projectRepository whose update-access read runs `inWindow` after reading, before returning. */
function projectsWithWindow(inWindow: () => Promise<unknown>) {
  const shareable = projectRepository.shareable;
  return Object.create(projectRepository, {
    shareable: {
      value: Object.create(shareable, {
        findUpdateAccessById: {
          value: async (...args: Parameters<typeof shareable.findUpdateAccessById>) => {
            const doc = await shareable.findUpdateAccessById(...args);
            await inWindow();
            return doc;
          },
        },
      }),
    },
  }) as typeof projectRepository;
}

async function seed() {
  const project = await Project.create({ name: 'P', description: 'd', userId: OWNER.id, fileIds: [], sessionIds: [] });
  const file = await FabFile.create({ userId: OWNER.id, fileName: 'f.txt', type: KnowledgeType.FILE });
  return { projectId: String(project._id), fileId: String(file._id) };
}

describe('sharing: projectService.addFiles', () => {
  it('keeps a share pushed onto project.users after its read', async () => {
    const { projectId, fileId } = await seed();

    await projectService.addFiles(
      OWNER,
      { projectId, fileIds: [fileId] },
      {
        db: {
          fabFiles: fabFileRepository,
          projects: projectsWithWindow(() =>
            Project.updateOne(
              { _id: projectId },
              { $push: { users: { userId: 'sharee', permissions: [Permission.read] } } }
            )
          ),
        },
      }
    );

    const after = await Project.findById(projectId).lean();
    expect(after?.users?.map(u => u.userId)).toEqual(['sharee']);
    expect(after?.fileIds).toEqual([fileId]);
  });

  it('refuses, and does not resurrect, a project soft-deleted after its read', async () => {
    const { projectId, fileId } = await seed();
    const deletedAt = new Date();

    const write = projectService.addFiles(
      OWNER,
      { projectId, fileIds: [fileId] },
      {
        db: {
          fabFiles: fabFileRepository,
          projects: projectsWithWindow(() =>
            Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(projectId) }, { $set: { deletedAt } })
          ),
        },
      }
    );
    await expect(write).rejects.toThrow(NotFoundError);

    // Raw collection read: the soft-delete plugin hides deleted rows from model finds.
    const after = await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) });
    expect(after?.deletedAt).toEqual(deletedAt);
    expect(after?.fileIds).toEqual([]);
    expect((await FabFile.findById(fileId).lean())?.users ?? []).toEqual([]);
  });
});
