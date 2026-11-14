import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  FabFile,
  Organization,
  OrganizationAuditEventModel,
  OrganizationGeneratedObject,
  OrganizationRetentionEstimate,
  Quest,
  Session,
  User,
} from '@bike4mind/database';
import { FabFileSourceType, foreverRetention } from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  createRetentionEstimate,
  estimateRetention,
  saveRetentionPolicy,
  RETENTION_SESSION_PAGE_SIZE,
  RETENTION_ESTIMATE_MS,
} from '@bike4mind/server-utils/organizations/retentionPolicy';

const effects = vi.hoisted(() => ({ files: vi.fn(), media: vi.fn(), unpublish: vi.fn(), flush: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ delete: effects.files }),
  getGeneratedImageStorage: () => ({ delete: effects.media }),
}));
vi.mock('@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts', () => ({
  unpublishUserArtifactsBySource: effects.unpublish,
}));
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', () => ({
  createCdnInvalidationBatch: () => ({ add: vi.fn(), flush: effects.flush }),
  generatedCdnPath: (key: string) => `/generated/${key}`,
  MAX_PATHS_PER_BATCH: 3000,
}));
import { cleanupOrganizationRetention } from './retentionCleanup';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const now = new Date('2026-10-12T12:00:00Z');
const old = new Date('2026-10-10T12:00:00Z');
const boundary = new Date('2026-10-11T12:00:00Z');
const orgId = new mongoose.Types.ObjectId().toString();
const ownerId = new mongoose.Types.ObjectId().toString();
const otherOrg = new mongoose.Types.ObjectId().toString();
const key = '12345678-1234-1234-1234-123456789abc.png';
let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const options = () => ({ now, logger: logger as never });

async function notebook(organizationId?: string) {
  const _id = new mongoose.Types.ObjectId();
  await Session.collection.insertOne({
    _id,
    userId: ownerId,
    retentionOrganizationId: organizationId,
    name: 'disposable',
    deletedAt: null,
  });
  return String(_id);
}
async function message(sessionId: string, timestamp = old, extra = {}) {
  const { insertedId } = await Quest.collection.insertOne({
    sessionId,
    timestamp,
    deletedAt: null,
    type: 'message',
    prompt: 'disposable',
    ...extra,
  });
  return insertedId;
}
async function file(organizationId?: string, createdAt = old, generated = false) {
  const { insertedId } = await FabFile.collection.insertOne({
    userId: ownerId,
    organizationId,
    createdAt,
    deletedAt: null,
    fileName: 'disposable.txt',
    filePath: `${new mongoose.Types.ObjectId()}.txt`,
    users: [],
    tags: [],
    fileSize: 10,
    storageChargedAt: old,
    ...(generated
      ? { sourceType: FabFileSourceType.TOOL_GENERATED, sourceMetadata: { retentionOrganizationId: organizationId } }
      : {}),
  });
  return insertedId;
}
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const effect of Object.values(effects)) effect.mockReset();
  for (const model of [
    FabFile,
    Organization,
    OrganizationAuditEventModel,
    OrganizationGeneratedObject,
    OrganizationRetentionEstimate,
    Quest,
    Session,
    User,
  ])
    await model.collection.deleteMany({});
  await Organization.collection.insertOne({
    _id: new mongoose.Types.ObjectId(orgId),
    userId: ownerId,
    personal: false,
    retentionPolicy: { chats: 1, files: 1, media: 1 },
    retentionVersion: 1,
    currentStorageSize: 1000,
  });
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(ownerId), name: 'Disposable', users: [] });
});

describe('explicit organization retention on disposable data', () => {
  it('estimates only explicitly owned data strictly older than the cutoff', async () => {
    await message(await notebook(orgId));
    await message(await notebook(orgId), boundary);
    await message(await notebook());
    await message(await notebook(otherOrg));
    await file(orgId);
    await file(orgId, boundary);
    await file();
    await file(otherOrg);
    await file(orgId, old, true);
    expect(await estimateRetention(orgId, { chats: 1, files: 1, media: 1 }, now)).toEqual({
      chats: 1,
      files: 1,
      media: 1,
    });
  });
  it('does nothing for forever or absent policies', async () => {
    await message(await notebook(orgId));
    await file(orgId);
    await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(orgId) },
      { $unset: { retentionPolicy: 1 } }
    );
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 0 });
    expect(effects.files).not.toHaveBeenCalled();
  });
  it('uses the retention stamp independently of storage ownership', async () => {
    const target = await file(undefined, old, true);
    await FabFile.collection.updateOne({ _id: target }, { $set: { 'sourceMetadata.retentionOrganizationId': orgId } });
    const foreign = await file(orgId, old, true);
    await FabFile.collection.updateOne(
      { _id: foreign },
      { $set: { 'sourceMetadata.retentionOrganizationId': otherOrg } }
    );
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 1 });
    expect((await FabFile.collection.findOne({ _id: target }))?.deletedAt).toBeInstanceOf(Date);
    expect((await FabFile.collection.findOne({ _id: foreign }))?.deletedAt).toBeNull();
    expect(
      (await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(orgId) }))?.currentStorageSize
    ).toBe(1000);
  });
  it('skips held notebooks, messages and files', async () => {
    const sessionId = await notebook(orgId);
    await Session.collection.updateOne({ _id: new mongoose.Types.ObjectId(sessionId) }, { $set: { legalHold: true } });
    await message(sessionId);
    await message(await notebook(orgId), old, { legalHold: true });
    const fileId = await file(orgId);
    await FabFile.collection.updateOne({ _id: fileId }, { $set: { legalHold: true } });
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 0 });
  });
  it('deletes only eligible chat, file and generated rows and audits once across reruns', async () => {
    const sessionId = await notebook(orgId);
    await Session.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      { $set: { summary: 'old text', contextSummary: 'old context', contextSummaryUpToQuestId: 'old' } }
    );
    const target = await message(sessionId);
    const personal = await message(await notebook());
    const foreign = await message(await notebook(otherOrg));
    const exact = await message(await notebook(orgId), boundary);
    await file(orgId);
    await file(orgId, old, true);
    await file();
    await file(otherOrg);
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 1, files: 1, media: 1 });
    expect((await Quest.collection.findOne({ _id: target }))?.deletedAt).toBeInstanceOf(Date);
    const cleaned = await Session.collection.findOne({ _id: new mongoose.Types.ObjectId(sessionId) });
    expect(cleaned).not.toHaveProperty('summary');
    expect(cleaned).not.toHaveProperty('contextSummary');
    expect(cleaned).not.toHaveProperty('contextSummaryUpToQuestId');
    for (const _id of [personal, foreign, exact])
      expect((await Quest.collection.findOne({ _id }))?.deletedAt).toBeNull();
    expect(effects.files).toHaveBeenCalledTimes(2);
    expect(
      await OrganizationAuditEventModel.countDocuments({ organizationId: orgId, action: 'retention.deleted' })
    ).toBe(3);
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 0 });
    expect(await OrganizationAuditEventModel.countDocuments({ action: 'retention.deleted' })).toBe(3);
    expect(
      (await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(orgId) }))?.currentStorageSize
    ).toBe(980);
  });
  it('retains personal-copy media while deleting an expired org original reference', async () => {
    const sessionId = await notebook(orgId);
    // At the chat cutoff, so chat retention leaves it alone and the media pass is what detaches it.
    await message(sessionId, boundary, { images: [key] });
    await message(await notebook(), old, { images: [key] });
    await OrganizationGeneratedObject.create({
      key,
      organizationId: orgId,
      userId: ownerId,
      sessionId,
      createdAt: old,
    });
    await cleanupOrganizationRetention(orgId, options());
    expect(effects.media).not.toHaveBeenCalled();
    expect(await OrganizationGeneratedObject.countDocuments({ deletedAt: null })).toBe(1);
    expect(await OrganizationAuditEventModel.countDocuments({ action: 'retention.media_detached' })).toBe(1);
    expect(await Quest.countDocuments({ sessionId, images: key })).toBe(0);
    expect(await Quest.countDocuments({ sessionId: { $ne: sessionId }, images: key })).toBe(1);
  });
  it('purges an explicitly owned unreferenced generated object and audits it once', async () => {
    const sessionId = await notebook(orgId);
    await OrganizationGeneratedObject.create({
      key,
      organizationId: orgId,
      userId: ownerId,
      sessionId,
      createdAt: old,
    });
    await cleanupOrganizationRetention(orgId, options());
    await cleanupOrganizationRetention(orgId, options());
    expect(effects.media).toHaveBeenCalledExactlyOnceWith(key);
    expect(await OrganizationAuditEventModel.countDocuments({ action: 'retention.deleted' })).toBe(1);
  });
  it('preserves live output-file references and moderation evidence even on deleted rows', async () => {
    const sessionId = await notebook(orgId);
    await OrganizationGeneratedObject.create({
      key,
      organizationId: orgId,
      userId: ownerId,
      sessionId,
      createdAt: old,
    });
    const fileId = await file();
    await FabFile.collection.updateOne({ _id: fileId }, { $set: { sourceMetadata: { generatedOutputKey: key } } });
    await cleanupOrganizationRetention(orgId, options());
    expect(effects.media).not.toHaveBeenCalled();
    await FabFile.collection.updateOne({ _id: fileId }, { $set: { deletedAt: now, moderationStatus: 'blocked' } });
    await cleanupOrganizationRetention(orgId, options());
    expect(effects.media).not.toHaveBeenCalled();
  });
  it('respects the per-run batch and deadline', async () => {
    await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(orgId) },
      { $set: { retentionPolicy: { chats: 1, files: null, media: null } } }
    );
    const sessionId = await notebook(orgId);
    for (let i = 0; i < 55; i++) await message(sessionId);
    expect((await cleanupOrganizationRetention(orgId, { ...options(), deadline: Date.now() - 1 })).chats).toBe(0);
    expect((await cleanupOrganizationRetention(orgId, options())).chats).toBe(50);
    expect((await cleanupOrganizationRetention(orgId, options())).chats).toBe(5);
  });
  it('requires a fresh actor/org/policy/version-bound estimate before shortening', async () => {
    const next = { chats: 1, files: null, media: null };
    await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(orgId) },
      { $set: { retentionPolicy: foreverRetention } }
    );
    await expect(saveRetentionPolicy(orgId, ownerId, next, 1, undefined, now)).rejects.toThrow('estimate');
    const estimate = await createRetentionEstimate(orgId, ownerId, 1, next, now);
    await expect(saveRetentionPolicy(orgId, 'different-admin', next, 1, estimate.token, now)).rejects.toThrow(
      'estimate'
    );
    await expect(saveRetentionPolicy(orgId, ownerId, { ...next, chats: 2 }, 1, estimate.token, now)).rejects.toThrow(
      'estimate'
    );
    await expect(
      saveRetentionPolicy(orgId, ownerId, next, 1, estimate.token, new Date(now.getTime() + 600001))
    ).rejects.toThrow('estimate');
    expect(await saveRetentionPolicy(orgId, ownerId, next, 1, estimate.token, now)).toEqual({
      policy: next,
      version: 2,
    });
    await expect(saveRetentionPolicy(orgId, ownerId, next, 1, estimate.token, now)).rejects.toThrow('changed');
    expect(await OrganizationAuditEventModel.countDocuments({ action: 'policy.updated' })).toBe(1);
  });
  it('concurrent sweeps record one deletion per message', async () => {
    await message(await notebook(orgId));
    await Promise.allSettled([
      cleanupOrganizationRetention(orgId, options()),
      cleanupOrganizationRetention(orgId, options()),
    ]);
    expect(await OrganizationAuditEventModel.countDocuments({ action: 'retention.deleted' })).toBe(1);
  });
  describe('failure paths', () => {
    it('rejects policy saves for personal organizations', async () => {
      await Organization.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(orgId) },
        { $set: { personal: true } }
      );
      await expect(saveRetentionPolicy(orgId, ownerId, foreverRetention, 1)).rejects.toThrow('team organization');
    });
    // Trusted retention deletion must not require this uploader to resolve.
    const erasedUploaderFile = async () => {
      const _id = await file(orgId, new Date('2026-10-01T12:00:00Z'));
      await FabFile.collection.updateOne({ _id }, { $set: { userId: new mongoose.Types.ObjectId().toString() } });
      return _id;
    };
    const generatedObject = async (sessionId: string, objectKey = key) =>
      OrganizationGeneratedObject.create({
        key: objectKey,
        organizationId: orgId,
        userId: ownerId,
        sessionId,
        createdAt: old,
      });

    it('deletes erased-uploader files without starving chats across hourly scheduling drift', async () => {
      for (let i = 0; i < 50; i++) await erasedUploaderFile();
      await file(orgId);
      await message(await notebook(orgId));
      expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 1, files: 12, media: 0 });
      expect(await FabFile.countDocuments({ deletedAt: null })).toBe(39);
      const later = new Date(now.getTime() + 3_605_000);
      await message(await notebook(orgId));
      expect(await cleanupOrganizationRetention(orgId, { ...options(), now: later })).toEqual({
        chats: 1,
        files: 12,
        media: 0,
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });
    it('logs a failed file delete and keeps sweeping later files, chats and media', async () => {
      const bad = await erasedUploaderFile();
      effects.files.mockRejectedValueOnce(new Error('storage unavailable'));
      await file(orgId);
      const sessionId = await notebook(orgId);
      const target = await message(sessionId);
      await generatedObject(sessionId);
      expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 1, files: 1, media: 1 });
      expect(logger.warn).toHaveBeenCalledWith(
        'Retention delete failed; continuing with the next item',
        expect.objectContaining({ kind: 'files', id: String(bad) })
      );
      expect((await FabFile.collection.findOne({ _id: bad }))?.deletedAt).toBeNull();
      expect((await Quest.collection.findOne({ _id: target }))?.deletedAt).toBeInstanceOf(Date);
    });

    it('keeps a media object and its audit untouched when storage rejects, and retries next run', async () => {
      await generatedObject(await notebook(orgId));
      effects.media.mockRejectedValueOnce(new Error('storage down'));
      expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 0 });
      expect(await OrganizationGeneratedObject.countDocuments({ deletedAt: null })).toBe(1);
      expect(await OrganizationAuditEventModel.countDocuments({ action: 'retention.deleted' })).toBe(0);
      expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 1 });
      expect(await OrganizationGeneratedObject.countDocuments({ deletedAt: null })).toBe(0);
    });

    it('stops the whole sweep when the policy fence is no longer current', async () => {
      await file(orgId);
      const target = await message(await notebook(orgId));
      vi.spyOn(Organization.collection, 'updateOne').mockResolvedValueOnce({
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      });
      await expect(cleanupOrganizationRetention(orgId, options())).rejects.toThrow('Retention policy changed');
      expect(effects.files).not.toHaveBeenCalled();
      expect((await Quest.collection.findOne({ _id: target }))?.deletedAt).toBeNull();
    });
    it('reaches an eligible media object past a full batch of non-generated keys', async () => {
      for (let i = 0; i < 55; i++) await generatedObject(await notebook(orgId), `not-a-generated-key-${i}.png`);
      await generatedObject(await notebook(orgId));
      await cleanupOrganizationRetention(orgId, options());
      expect(effects.media).not.toHaveBeenCalled();
      for (let i = 0; i < 4; i++) await cleanupOrganizationRetention(orgId, options());
      expect(effects.media).toHaveBeenCalledExactlyOnceWith(key);
    });

    it('leaves work for chats and inline media when fifty file deletions fail again after an hour', async () => {
      for (let i = 0; i < 50; i++) await file(orgId);
      const origin = await notebook(orgId);
      await message(origin);
      await generatedObject(origin);
      effects.files.mockRejectedValue(new Error('persistent storage failure'));
      expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 1, files: 0, media: 1 });
      expect(effects.files).toHaveBeenCalledTimes(12);
      await message(origin);
      const laterKey = 'abcdefab-abcd-abcd-abcd-abcdefabcdef.png';
      await generatedObject(origin, laterKey);
      const later = new Date(now.getTime() + 3_605_000);
      expect(await cleanupOrganizationRetention(orgId, { ...options(), now: later })).toEqual({
        chats: 1,
        files: 0,
        media: 1,
      });
      expect(effects.files).toHaveBeenCalledTimes(24);
      expect(await FabFile.countDocuments({ deletedAt: null })).toBe(50);
      expect(effects.media).toHaveBeenCalledWith(laterKey);
    });
  });
  it('counts every indexed Session page while cleanup keeps its global fifty-message budget', async () => {
    await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(orgId) },
      { $set: { retentionPolicy: { chats: 1, files: null, media: null } } }
    );
    const aggregate = vi.spyOn(Session, 'aggregate');
    const total = RETENTION_SESSION_PAGE_SIZE + 1;
    for (let index = 0; index < total; index++) await message(await notebook(orgId));
    expect((await estimateRetention(orgId, { chats: 1, files: null, media: null }, now)).chats).toBe(total);
    expect((await cleanupOrganizationRetention(orgId, options())).chats).toBe(50);
    expect((await cleanupOrganizationRetention(orgId, options())).chats).toBe(50);
    expect((await cleanupOrganizationRetention(orgId, options())).chats).toBe(1);
    expect(aggregate).not.toHaveBeenCalled();
  });
  it('refuses a partial timed-out count before minting any confirmation token', async () => {
    for (let index = 0; index <= RETENTION_SESSION_PAGE_SIZE; index++) await message(await notebook(orgId));
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const count = Quest.collection.countDocuments.bind(Quest.collection);
    vi.spyOn(Quest.collection, 'countDocuments').mockImplementationOnce(async (...args) => {
      const result = await count(...args);
      clock.mockReturnValue(start + RETENTION_ESTIMATE_MS + 1);
      return result;
    });
    try {
      await expect(
        createRetentionEstimate(orgId, ownerId, 1, { chats: 1, files: null, media: null }, now)
      ).rejects.toThrow('timed out');
    } finally {
      clock.mockRestore();
    }
    expect(await OrganizationRetentionEstimate.countDocuments({})).toBe(0);
  });
  it('cannot recreate a subject estimate after erasure wins during the count', async () => {
    await message(await notebook(orgId));
    let releaseCount: (() => void) | undefined;
    let counted: (() => void) | undefined;
    const reachedCount = new Promise<void>(resolve => {
      counted = resolve;
    });
    const released = new Promise<void>(resolve => {
      releaseCount = resolve;
    });
    const count = Quest.collection.countDocuments.bind(Quest.collection);
    vi.spyOn(Quest.collection, 'countDocuments').mockImplementationOnce(async (...args) => {
      const result = await count(...args);
      counted?.();
      await released;
      return result;
    });
    const pending = createRetentionEstimate(orgId, ownerId, 1, { chats: 1, files: null, media: null }, now);
    await reachedCount;
    await User.deleteOne({ _id: ownerId });
    releaseCount?.();
    await expect(pending).rejects.toThrow('no longer active');
    expect(await OrganizationRetentionEstimate.countDocuments({})).toBe(0);
  });
  it('deletes organization files after the uploader is erased and refunds the organization exactly once', async () => {
    const id = await file(orgId);
    await User.deleteOne({ _id: ownerId });
    expect((await cleanupOrganizationRetention(orgId.toUpperCase(), options())).files).toBe(1);
    expect((await Organization.findById(orgId).lean())?.currentStorageSize).toBe(990);
    expect((await FabFile.findById(id).setOptions({ includeDeleted: true }).lean())?.deletedAt).toBeInstanceOf(Date);
    expect((await cleanupOrganizationRetention(orgId, options())).files).toBe(0);
    expect((await Organization.findById(orgId).lean())?.currentStorageSize).toBe(990);
    expect(effects.files).toHaveBeenCalledTimes(1);
  });
  it('uses immutable organization ownership when the creator and original notebook are gone', async () => {
    const origin = await notebook(orgId);
    await OrganizationGeneratedObject.create({
      key,
      organizationId: orgId,
      userId: 'deleted-account',
      sessionId: origin,
      createdAt: old,
    });
    await Session.collection.deleteOne({ _id: new mongoose.Types.ObjectId(origin) });
    await User.deleteOne({ _id: ownerId });
    expect((await cleanupOrganizationRetention(orgId, options())).media).toBe(1);
    expect(effects.media).toHaveBeenCalledWith(key);
    expect((await cleanupOrganizationRetention(orgId, options())).media).toBe(0);
  });
  it('retains a deleted foreign notebook legal hold beyond the first reference page', async () => {
    const origin = await notebook(orgId);
    await OrganizationGeneratedObject.create({
      key,
      organizationId: orgId,
      userId: ownerId,
      sessionId: origin,
      createdAt: old,
    });
    const unheld = await notebook(otherOrg);
    const held = await notebook(otherOrg);
    await Session.collection.updateMany(
      { _id: { $in: [new mongoose.Types.ObjectId(unheld), new mongoose.Types.ObjectId(held)] } },
      { $set: { deletedAt: now } }
    );
    await Session.collection.updateOne({ _id: new mongoose.Types.ObjectId(held) }, { $set: { legalHold: true } });
    for (let index = 0; index < 50; index++) await message(unheld, old, { images: [key], deletedAt: now });
    await message(held, old, { images: [key], deletedAt: now });
    expect((await cleanupOrganizationRetention(orgId, options())).media).toBe(0);
    expect(effects.media).not.toHaveBeenCalled();
    await Session.collection.updateOne({ _id: new mongoose.Types.ObjectId(held) }, { $unset: { legalHold: 1 } });
    expect((await cleanupOrganizationRetention(orgId, options())).media).toBe(1);
  });
  it('keeps the ledger locator after storage failure and retries the same owned object', async () => {
    await OrganizationGeneratedObject.create({
      key,
      organizationId: orgId,
      userId: 'deleted-account',
      sessionId: new mongoose.Types.ObjectId().toString(),
      createdAt: old,
    });
    effects.media.mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 0 });
    expect((await OrganizationGeneratedObject.findOne({ key }).lean())?.deletedAt).toBeUndefined();
    expect((await cleanupOrganizationRetention(orgId, options())).media).toBe(1);
  });
});
