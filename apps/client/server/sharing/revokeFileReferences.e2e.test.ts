import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  fabFileRepository,
  Session,
  sessionRepository,
  User,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { sessionService, sharingService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { createAttachmentLakeAccess } from '@server/dataLakes/attachmentLakeAccess';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * An owner revoking a share left the file in the recipient's system files and sessions. The turn-time
 * scrub keeps a live file the caller cannot read, so the reference warned on every turn for good.
 * Drives the REAL revoke (in a transaction, as the route does) and cleanup against a replica set.
 * Needs the built services dist: `pnpm turbo:core:build`.
 */

const logger = Logger.globalInstance;
const db = { users: userRepository, fabFiles: fabFileRepository, sessions: sessionRepository };

let replSet: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  await Promise.all([
    FabFile.collection.deleteMany({}),
    Session.collection.deleteMany({}),
    User.collection.deleteMany({}),
  ]);
});

const oid = () => new mongoose.Types.ObjectId();

const seedUser = async (fileId?: mongoose.Types.ObjectId, groups: string[] = []) => {
  const _id = oid();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    name: 'fixture',
    email: `${_id}@example.com`,
    groups,
    systemFiles: fileId ? [{ fileId: String(fileId), enabled: true }] : [],
  });
  if (fileId) {
    await Session.collection.insertOne({
      _id: oid(),
      userId: String(_id),
      knowledgeIds: [String(fileId)],
      deletedAt: null,
    });
  }
  return String(_id);
};

const seedFile = async (fileId: mongoose.Types.ObjectId, ownerId: string, extra: Record<string, unknown> = {}) =>
  FabFile.collection.insertOne({
    _id: fileId,
    userId: ownerId,
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
    users: [],
    groups: [],
    isGlobalRead: false,
    deletedAt: null,
    archivedAt: null,
    __v: 0,
    ...extra,
  });

const share = (userId: string) => ({ userId, permissions: ['read', 'write'] });

const revokeAndCleanUp = async (ownerId: string, fileId: string, recipientId: string) => {
  await withTransaction(() =>
    sharingService.revoke(
      ownerId,
      { id: fileId, type: 'files', userId: recipientId },
      { db: { ...db, projects: {} as never } }
    )
  );
  await sharingService.cleanUpRevokedFileReferences(fileId, recipientId, {
    db,
    resolveAttachmentLakeAccess: user =>
      createAttachmentLakeAccess(user as never, logger, { requireCompleteView: true })(),
    logger,
  });
};

const systemFileIds = async (userId: string) =>
  ((await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }))?.systemFiles ?? []).map(
    (f: { fileId: string }) => f.fileId
  );
const sessionKnowledgeIds = async (userId: string) =>
  ((await Session.collection.findOne({ userId }))?.knowledgeIds ?? []) as string[];

describe('revoking a file share cleans up the recipient references', () => {
  it('without cleanup the revoked file stays pinned and the turn-time scrub never removes it', async () => {
    const fileId = oid();
    const ownerId = await seedUser(fileId);
    const recipientId = await seedUser(fileId);
    await seedFile(fileId, ownerId, { users: [share(recipientId)] });

    await withTransaction(() =>
      sharingService.revoke(
        ownerId,
        { id: String(fileId), type: 'files', userId: recipientId },
        { db: { ...db, projects: {} as never } }
      )
    );
    // What the turn reports for a pinned file it could not load.
    const notices = [
      {
        fabFileId: String(fileId),
        fileName: String(fileId),
        band: 'unresolved' as const,
        message: '',
        delivered: false,
      },
    ];
    const removed = await sessionService.scrubStaleSystemFiles(recipientId, [String(fileId)], notices, {
      db: { fabFiles: fabFileRepository, users: userRepository },
    });

    expect(removed).toEqual([]);
    expect(await systemFileIds(recipientId)).toEqual([String(fileId)]);
  });

  it("drops the file from the recipient's system files and sessions, and only theirs", async () => {
    const fileId = oid();
    const ownerId = await seedUser(fileId);
    const recipientId = await seedUser(fileId);
    await seedFile(fileId, ownerId, { users: [share(recipientId)] });

    await revokeAndCleanUp(ownerId, String(fileId), recipientId);

    expect(await systemFileIds(recipientId)).toEqual([]);
    expect(await sessionKnowledgeIds(recipientId)).toEqual([]);
    expect(await systemFileIds(ownerId)).toEqual([String(fileId)]);
    expect(await sessionKnowledgeIds(ownerId)).toEqual([String(fileId)]);
  });

  it('keeps the references when the file is still globally readable', async () => {
    const fileId = oid();
    const ownerId = await seedUser();
    const recipientId = await seedUser(fileId);
    await seedFile(fileId, ownerId, { users: [share(recipientId)], isGlobalRead: true });

    await revokeAndCleanUp(ownerId, String(fileId), recipientId);

    expect(await systemFileIds(recipientId)).toEqual([String(fileId)]);
    expect(await sessionKnowledgeIds(recipientId)).toEqual([String(fileId)]);
  });

  it("keeps the references when the file is still shared with the recipient's group", async () => {
    const fileId = oid();
    const groupId = String(oid());
    const ownerId = await seedUser();
    const recipientId = await seedUser(fileId, [groupId]);
    await seedFile(fileId, ownerId, {
      users: [share(recipientId)],
      groups: [{ groupId, permissions: ['read'] }],
    });

    await revokeAndCleanUp(ownerId, String(fileId), recipientId);

    expect(await systemFileIds(recipientId)).toEqual([String(fileId)]);
  });
});
