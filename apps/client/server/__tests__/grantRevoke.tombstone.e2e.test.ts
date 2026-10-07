/**
 * Real-Mongo regression for grant revocation racing a soft delete. The revoke paths filter `users` in
 * memory and write it back; when the target is soft-deleted between that read and the write, the
 * write must still strip the grant on the tombstone (an undelete would otherwise restore the revoked
 * access) and must not resurrect it.
 *
 * Consumes the built dist (`pnpm turbo:core:build`); integration lane only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  Project,
  Session,
  fabFileRepository,
  projectRepository,
  sessionRepository,
} from '@bike4mind/database';
import { sessionService, sharingService } from '@bike4mind/services';
import { KnowledgeType, Permission, type IUserRepository } from '@bike4mind/common';

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
  await Promise.all([
    Project.deleteMany({}, { hardDelete: true }),
    FabFile.deleteMany({}, { hardDelete: true }),
    Session.deleteMany({}, { hardDelete: true }),
  ]);
});

const OWNER = 'owner';
const SHAREE = 'sharee';
const SHARE = { userId: SHAREE, permissions: [Permission.read] };

const users = { findById: async (id: string) => ({ id, groups: [] }) } as unknown as IUserRepository;

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const asModel = (m: unknown) => m as mongoose.Model<never>;

/** Tombstones a row the way softDeletePlugin does: a raw `$set` of deletedAt, `__v` untouched. */
const softDelete = (model: mongoose.Model<never>, id: string, deletedAt: Date) =>
  model.collection.updateOne({ _id: oid(id) }, { $set: { deletedAt } });

/** Straight from the collection: the plugin's find hooks hide tombstones. */
const raw = (model: mongoose.Model<never>, id: string) => model.collection.findOne({ _id: oid(id) });

/** `repo` whose `shareable.findAccessibleById` runs `inWindow` after reading, before returning. */
function withAccessWindow<R extends { shareable: object }>(repo: R, inWindow: () => Promise<unknown>): R {
  const shareable = repo.shareable as { findAccessibleById: (...args: unknown[]) => Promise<unknown> };
  return Object.create(repo, {
    shareable: {
      value: Object.create(shareable, {
        findAccessibleById: {
          value: async (...args: unknown[]) => {
            const doc = await shareable.findAccessibleById(...args);
            await inWindow();
            return doc;
          },
        },
      }),
    },
  }) as R;
}

/** fabFileRepository whose `findAllByIds` runs `inWindow` after reading, before returning. */
function filesWithFindAllWindow(inWindow: () => Promise<unknown>) {
  return Object.create(fabFileRepository, {
    findAllByIds: {
      value: async (...args: Parameters<typeof fabFileRepository.findAllByIds>) => {
        const docs = await fabFileRepository.findAllByIds(...args);
        await inWindow();
        return docs;
      },
    },
  }) as typeof fabFileRepository;
}

const seedFile = async (userId: string, share: object) => {
  const file = await FabFile.create({ userId, fileName: 'f.txt', type: KnowledgeType.FILE, users: [share] });
  return String(file._id);
};

const seedSession = async (sessionId: string, knowledgeIds: string[], sessionUsers: object[]) => {
  const now = new Date();
  await Session.create({
    _id: oid(sessionId),
    name: 'S',
    userId: OWNER,
    lastUpdated: now,
    firstCreated: now,
    knowledgeIds,
    users: sessionUsers,
  });
};

describe('sharingService.revoke racing a soft delete', () => {
  it('strips the grant from a file tombstoned after the read, without resurrecting it', async () => {
    const fileId = await seedFile(OWNER, SHARE);
    const deletedAt = new Date();

    await sharingService.revoke(
      OWNER,
      { id: fileId, type: 'files', userId: SHAREE },
      {
        db: {
          users,
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: withAccessWindow(fabFileRepository, () => softDelete(asModel(FabFile), fileId, deletedAt)),
        },
      }
    );

    const after = await raw(asModel(FabFile), fileId);
    expect(after?.users).toEqual([]);
    expect(after?.deletedAt).toEqual(deletedAt);
  });

  it('strips the grant from a project tombstoned after the read, without resurrecting it', async () => {
    const project = await Project.create({
      name: 'P',
      description: 'd',
      userId: OWNER,
      fileIds: [],
      sessionIds: [],
      users: [SHARE],
    });
    const projectId = String(project._id);
    const deletedAt = new Date();

    await sharingService.revoke(
      OWNER,
      { id: projectId, type: 'projects', userId: SHAREE },
      {
        db: {
          users,
          sessions: sessionRepository,
          fabFiles: fabFileRepository,
          projects: withAccessWindow(projectRepository, () => softDelete(asModel(Project), projectId, deletedAt)),
        },
      }
    );

    const after = await raw(asModel(Project), projectId);
    expect(after?.users).toEqual([]);
    expect(after?.deletedAt).toEqual(deletedAt);
  });

  it("strips the session's knowledge-file grant from a file tombstoned after the cascade's read", async () => {
    const sessionId = new mongoose.Types.ObjectId().toString();
    const fileId = await seedFile(OWNER, { ...SHARE, sessionId });
    await seedSession(sessionId, [fileId], [SHARE]);
    const deletedAt = new Date();

    await sharingService.revoke(
      OWNER,
      { id: sessionId, type: 'sessions', userId: SHAREE },
      {
        db: {
          users,
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: filesWithFindAllWindow(() => softDelete(asModel(FabFile), fileId, deletedAt)),
        },
      }
    );

    const after = await raw(asModel(FabFile), fileId);
    expect(after?.users).toEqual([]);
    expect(after?.deletedAt).toEqual(deletedAt);
    expect((await raw(asModel(Session), sessionId))?.users).toEqual([]);
  });
});

describe('sessionService.deleteSession racing a soft delete', () => {
  it("strips the session's grant from a sharee's file tombstoned after the read", async () => {
    const sessionId = new mongoose.Types.ObjectId().toString();
    const fileId = await seedFile('someone-else', { ...SHARE, sessionId });
    await seedSession(sessionId, [fileId], []);
    const deletedAt = new Date();

    await sessionService.deleteSession(
      OWNER,
      { id: sessionId },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: filesWithFindAllWindow(() => softDelete(asModel(FabFile), fileId, deletedAt)),
        },
      }
    );

    const after = await raw(asModel(FabFile), fileId);
    expect(after?.users).toEqual([]);
    expect(after?.deletedAt).toEqual(deletedAt);
  });
});
