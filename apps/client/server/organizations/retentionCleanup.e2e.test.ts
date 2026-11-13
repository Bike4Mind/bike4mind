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
    ...(generated ? { sourceType: FabFileSourceType.TOOL_GENERATED } : {}),
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
  vi.clearAllMocks();
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
    const target = await message(await notebook(orgId));
    const personal = await message(await notebook());
    const foreign = await message(await notebook(otherOrg));
    const exact = await message(await notebook(orgId), boundary);
    await file(orgId);
    await file(orgId, old, true);
    await file();
    await file(otherOrg);
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 1, files: 1, media: 1 });
    expect((await Quest.collection.findOne({ _id: target }))?.deletedAt).toBeInstanceOf(Date);
    for (const _id of [personal, foreign, exact])
      expect((await Quest.collection.findOne({ _id }))?.deletedAt).toBeNull();
    expect(effects.files).toHaveBeenCalledTimes(2);
    expect(
      await OrganizationAuditEventModel.countDocuments({ organizationId: orgId, action: 'retention.deleted' })
    ).toBe(3);
    expect(await cleanupOrganizationRetention(orgId, options())).toEqual({ chats: 0, files: 0, media: 0 });
    expect(await OrganizationAuditEventModel.countDocuments({ action: 'retention.deleted' })).toBe(3);
  });
  it('retains personal-copy media while deleting an expired org original reference', async () => {
    const sessionId = await notebook(orgId);
    await message(sessionId, old, { images: [key] });
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
    await Promise.all([cleanupOrganizationRetention(orgId, options()), cleanupOrganizationRetention(orgId, options())]);
    expect(await OrganizationAuditEventModel.countDocuments({ action: 'retention.deleted' })).toBe(1);
  });
});
