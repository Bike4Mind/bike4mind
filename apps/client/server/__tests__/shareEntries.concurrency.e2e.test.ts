import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  Invite,
  Project,
  User,
  fabFileRepository,
  inviteRepository,
  projectRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { projectService, sharingService } from '@bike4mind/services';
import { InviteType, KnowledgeType, Permission, type IUserDocument } from '@bike4mind/common';

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
    User.deleteMany({}),
    Invite.deleteMany({}),
  ]);
});

const makeUser = async (name: string) => {
  const user = await User.create({
    name,
    username: `${name}-${new mongoose.Types.ObjectId().toString()}`,
    email: `${name}@example.com`,
    password: null,
    hasUsablePassword: false,
  });
  return { id: String(user._id), email: `${name}@example.com`, groups: [] } as unknown as IUserDocument;
};

const revokeAdapters = {
  db: { fabFiles: fabFileRepository, sessions: sessionRepository, projects: projectRepository, users: userRepository },
};

/** fabFileRepository whose `read` resolves, then runs `inWindow` before handing the doc back. */
function fabFilesWithWindow(
  read: 'findById' | 'findAllAccessibleByIds',
  inWindow: () => Promise<unknown>
): typeof fabFileRepository {
  const withWindow =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const result = await fn(...args);
      await inWindow();
      return result;
    };
  if (read === 'findById') {
    return Object.create(fabFileRepository, {
      findById: { value: withWindow(fabFileRepository.findById.bind(fabFileRepository)) },
    });
  }
  const shareable = fabFileRepository.shareable;
  return Object.create(fabFileRepository, {
    shareable: {
      value: Object.create(shareable, {
        findAllAccessibleByIds: { value: withWindow(shareable.findAllAccessibleByIds.bind(shareable)) },
      }),
    },
  });
}

const sharees = async (fileId: string) =>
  ((await FabFile.findById(fileId).lean())?.users ?? []).map(u => ({ userId: u.userId, projectId: u.projectId }));

describe('concurrent share and revoke keep both changes', () => {
  it('projectService.addFiles keeps a revoke that commits during the share', async () => {
    const owner = await makeUser('owner');
    const revoked = await makeUser('revoked');
    const member = await makeUser('member');
    const file = await FabFile.create({
      userId: owner.id,
      fileName: 'f.txt',
      type: KnowledgeType.FILE,
      users: [{ userId: revoked.id, permissions: [Permission.read] }],
    });
    const fileId = String(file._id);
    const project = await Project.create({
      name: 'P',
      description: 'd',
      userId: owner.id,
      fileIds: [],
      sessionIds: [],
      users: [{ userId: member.id, permissions: [Permission.read] }],
    });

    await projectService.addFiles(
      owner,
      { projectId: String(project._id), fileIds: [fileId] },
      {
        db: {
          projects: projectRepository,
          fabFiles: fabFilesWithWindow('findAllAccessibleByIds', () =>
            sharingService.revoke(owner.id, { id: fileId, type: 'files', userId: revoked.id }, revokeAdapters)
          ),
        },
      }
    );

    expect(await sharees(fileId)).toEqual([{ userId: member.id, projectId: String(project._id) }]);
  });

  it('acceptInvite keeps a revoke that commits during the accept', async () => {
    const owner = await makeUser('owner');
    const revoked = await makeUser('revoked');
    const accepter = await makeUser('accepter');
    const file = await FabFile.create({
      userId: owner.id,
      fileName: 'f.txt',
      type: KnowledgeType.FILE,
      users: [{ userId: revoked.id, permissions: [Permission.read] }],
    });
    const fileId = String(file._id);
    const invite = await Invite.create({
      type: InviteType.FabFile,
      documentId: fileId,
      inviterId: owner.id,
      isLinkOnly: true,
      permissions: [Permission.read],
      remaining: 1,
    });

    await sharingService.acceptInvite(
      accepter.id,
      { id: String(invite._id) },
      {
        db: {
          invites: inviteRepository,
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFilesWithWindow('findById', () =>
            sharingService.revoke(owner.id, { id: fileId, type: 'files', userId: revoked.id }, revokeAdapters)
          ),
          groups: { findById: async () => null },
          organization: {
            findById: async () => null,
            update: async () => null,
            ensureUserDetails: async () => undefined,
          },
          users: userRepository,
        },
      }
    );

    expect(await sharees(fileId)).toEqual([{ userId: accepter.id, projectId: undefined }]);
    const stored = await Invite.findById(invite._id).lean();
    expect(stored?.remaining).toBe(0);
    expect(stored?.recipients?.accepted).toEqual([accepter.email]);
  });
});
