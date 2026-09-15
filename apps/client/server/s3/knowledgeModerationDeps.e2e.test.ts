import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';

// buildKnowledgeModerationDeps calls getFilesStorage() at build time, which otherwise reaches for
// SST-provisioned S3 config these tests never boot; none of the claim-guard behaviour under test
// touches storage.
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: vi.fn(), downloadRange: vi.fn() }),
}));

import { buildKnowledgeModerationDeps } from './knowledgeModerationDeps';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

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
  vi.clearAllMocks();
});

async function seedScanning(filePath: string) {
  return FabFile.create({
    userId: 'user1',
    fileName: 'f',
    type: KnowledgeType.FILE,
    filePath,
    mimeType: 'image/png',
    moderationStatus: 'scanning',
    moderationClaimedAt: new Date(),
  });
}

/**
 * Every terminal write in the deps object (persist, release, retireMissingObject) must be guarded
 * on the exact claim stamp it was called with, not merely on `moderationStatus: 'scanning'` - a
 * superseded run (its claim reclaimed mid-scan by the rescue sweep, then re-claimed by a successor)
 * must be unable to clobber the successor's row. This is the guard #2865's P1 review comment found
 * missing from retireMissingObject.
 */
describe('buildKnowledgeModerationDeps claim guards (DB integration)', () => {
  it('retireMissingObject deletes the row when the claim stamp still matches', async () => {
    const deps = buildKnowledgeModerationDeps(logger);
    const doc = await seedScanning('knowledge/user1/orphan');

    const retired = await deps.retireMissingObject(doc._id, doc.moderationClaimedAt as Date);

    expect(retired).toBe(true);
    expect(await FabFile.findOne({ _id: doc._id })).toBeNull();
    const row = await FabFile.findOne({ _id: doc._id }).setOptions({ includeDeleted: true }).lean();
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('retireMissingObject does not delete a row a successor has already re-claimed and resolved', async () => {
    const deps = buildKnowledgeModerationDeps(logger);
    const doc = await seedScanning('knowledge/user1/raced');
    const staleClaimedAt = doc.moderationClaimedAt as Date;

    // Simulate a successor: the sweep reclaimed this row (moderationClaimedAt cleared, back to
    // pending), and a second runner then claimed and scanned it clean.
    await FabFile.collection.updateOne(
      { _id: doc._id },
      { $set: { moderationStatus: 'clean' }, $unset: { moderationClaimedAt: 1 } }
    );

    const retired = await deps.retireMissingObject(doc._id, staleClaimedAt);

    expect(retired).toBe(false);
    const row = await FabFile.findOne({ _id: doc._id }).lean();
    expect(row?.moderationStatus).toBe('clean');
    expect(row?.deletedAt).toBeFalsy();
  });

  it('release does not clear a claim a successor has already taken over', async () => {
    const deps = buildKnowledgeModerationDeps(logger);
    const doc = await seedScanning('knowledge/user1/released');
    const staleClaimedAt = doc.moderationClaimedAt as Date;

    const successorClaimedAt = new Date(Date.now() + 1000);
    await FabFile.collection.updateOne({ _id: doc._id }, { $set: { moderationClaimedAt: successorClaimedAt } });

    await deps.release(doc._id, staleClaimedAt);

    const row = await FabFile.findOne({ _id: doc._id }).lean();
    expect(row?.moderationStatus).toBe('scanning');
    expect(row?.moderationClaimedAt).toEqual(successorClaimedAt);
  });

  it('persist does not overwrite a verdict a successor has already written', async () => {
    const deps = buildKnowledgeModerationDeps(logger);
    const doc = await seedScanning('knowledge/user1/persisted');
    const staleClaimedAt = doc.moderationClaimedAt as Date;

    await FabFile.collection.updateOne(
      { _id: doc._id },
      { $set: { moderationStatus: 'blocked' }, $unset: { moderationClaimedAt: 1 } }
    );

    const applied = await deps.persist(doc._id, { moderationStatus: 'clean' }, staleClaimedAt);

    expect(applied).toBe(false);
    const row = await FabFile.findOne({ _id: doc._id }).lean();
    expect(row?.moderationStatus).toBe('blocked');
  });
});
