import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';
import { claimModerationScan, recordLandedObject, writeModerationVerdict } from './moderationScan';

// The reset is a pipeline update, so it runs against a real mongod rather than a mocked model.
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
  await mongoose.connection.dropDatabase();
});

const seed = (fields: Record<string, unknown>) =>
  FabFile.create({ userId: 'user1', fileName: 'f', type: KnowledgeType.FILE, filePath: 'uploads/f.png', ...fields });

describe('recordLandedObject', () => {
  it('sends a clean verdict for another version back to pending, so the overwrite is rescanned', async () => {
    const doc = await seed({ moderationStatus: 'clean', moderationETag: 'etag-a' });

    await recordLandedObject(doc._id, 'etag-b');

    const row = await FabFile.findById(doc._id).lean();
    expect(row).toMatchObject({ moderationStatus: 'pending', moderationETag: 'etag-b' });
    expect(await claimModerationScan(doc._id, new Date())).not.toBeNull();
  });

  it('resets a blocked verdict and drops its reason, so a rescan does not inherit it', async () => {
    const doc = await seed({ moderationStatus: 'blocked', blockReason: 'explicit', moderationETag: 'etag-a' });

    await recordLandedObject(doc._id, 'etag-b');

    const row = await FabFile.findById(doc._id).lean();
    expect(row?.moderationStatus).toBe('pending');
    expect(row?.blockReason).toBeUndefined();
  });

  it('treats a verdict with no recorded version as covering another one', async () => {
    const doc = await seed({ moderationStatus: 'clean' });

    await recordLandedObject(doc._id, 'etag-a');

    expect((await FabFile.findById(doc._id).lean())?.moderationStatus).toBe('pending');
  });

  it('leaves a verdict for the same version alone (a redelivered event)', async () => {
    const doc = await seed({ moderationStatus: 'clean', moderationETag: 'etag-a-3' });

    await recordLandedObject(doc._id, 'etag-a-3');

    expect((await FabFile.findById(doc._id).lean())?.moderationStatus).toBe('clean');
  });

  it('only records the version on a first landing that has no verdict yet', async () => {
    const doc = await seed({ moderationStatus: 'pending' });

    await recordLandedObject(doc._id, 'etag-a');

    expect(await FabFile.findById(doc._id).lean()).toMatchObject({
      moderationStatus: 'pending',
      moderationETag: 'etag-a',
    });
  });

  it('drops an in-flight scan of another version, so its stale verdict cannot land', async () => {
    const doc = await seed({ moderationStatus: 'pending' });
    const claimedAt = new Date();
    await claimModerationScan(doc._id, claimedAt, 'etag-a');

    await recordLandedObject(doc._id, 'etag-b');

    expect(await writeModerationVerdict(doc._id, claimedAt, { moderationStatus: 'clean' })).toBe(false);
    const row = await FabFile.findById(doc._id).lean();
    expect(row?.moderationStatus).toBe('pending');
    expect(row?.moderationClaimedAt).toBeUndefined();
  });

  it('keeps an in-flight scan of the same version', async () => {
    const doc = await seed({ moderationStatus: 'pending' });
    const claimedAt = new Date();
    await claimModerationScan(doc._id, claimedAt, 'etag-a');

    await recordLandedObject(doc._id, 'etag-a');

    expect(await writeModerationVerdict(doc._id, claimedAt, { moderationStatus: 'clean' })).toBe(true);
  });
});
