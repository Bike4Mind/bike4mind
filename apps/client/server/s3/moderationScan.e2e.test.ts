import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';
import { claimModerationScan, recordLandedObject, writeModerationVerdict } from './moderationScan';

// The reset is a pipeline update, so it runs against a real mongod rather than a mocked model.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({ getMetadata: vi.fn() }));
const logger = { warn: vi.fn() };
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getMetadata: h.getMetadata }),
}));
beforeEach(() => {
  h.getMetadata.mockReset();
});

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

    h.getMetadata.mockResolvedValue({ etag: 'etag-b' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    const row = await FabFile.findById(doc._id).lean();
    expect(row).toMatchObject({ moderationStatus: 'pending', moderationETag: 'etag-b' });
    expect(await claimModerationScan(doc._id, new Date())).not.toBeNull();
  });

  it('resets a blocked verdict and drops its reason, so a rescan does not inherit it', async () => {
    const doc = await seed({ moderationStatus: 'blocked', blockReason: 'explicit', moderationETag: 'etag-a' });

    h.getMetadata.mockResolvedValue({ etag: 'etag-b' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    const row = await FabFile.findById(doc._id).lean();
    expect(row?.moderationStatus).toBe('pending');
    expect(row?.blockReason).toBeUndefined();
  });

  it('treats a verdict with no recorded version as covering another one', async () => {
    const doc = await seed({ moderationStatus: 'clean' });

    h.getMetadata.mockResolvedValue({ etag: 'etag-a' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    expect((await FabFile.findById(doc._id).lean())?.moderationStatus).toBe('pending');
  });

  it('leaves a verdict for the same version alone (a redelivered event)', async () => {
    const doc = await seed({ moderationStatus: 'clean', moderationETag: 'etag-a-3' });

    h.getMetadata.mockResolvedValue({ etag: 'etag-a-3' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    expect((await FabFile.findById(doc._id).lean())?.moderationStatus).toBe('clean');
  });

  it('only records the version on a first landing that has no verdict yet', async () => {
    const doc = await seed({ moderationStatus: 'pending' });

    h.getMetadata.mockResolvedValue({ etag: 'etag-a' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    expect(await FabFile.findById(doc._id).lean()).toMatchObject({
      moderationStatus: 'pending',
      moderationETag: 'etag-a',
    });
  });

  it('drops an in-flight scan of another version, so its stale verdict cannot land', async () => {
    const doc = await seed({ moderationStatus: 'pending' });
    const claimedAt = new Date();
    h.getMetadata.mockResolvedValue({ etag: 'etag-a' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);
    await claimModerationScan(doc._id, claimedAt);

    h.getMetadata.mockResolvedValue({ etag: 'etag-b' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    expect(await writeModerationVerdict(doc._id, claimedAt, { moderationStatus: 'clean' })).toBe(false);
    const row = await FabFile.findById(doc._id).lean();
    expect(row?.moderationStatus).toBe('pending');
    expect(row?.moderationClaimedAt).toBeUndefined();
  });

  it('keeps an in-flight scan of the same version', async () => {
    const doc = await seed({ moderationStatus: 'pending' });
    const claimedAt = new Date();
    h.getMetadata.mockResolvedValue({ etag: 'etag-a' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);
    await claimModerationScan(doc._id, claimedAt);

    h.getMetadata.mockResolvedValue({ etag: 'etag-a' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    expect(await writeModerationVerdict(doc._id, claimedAt, { moderationStatus: 'clean' })).toBe(true);
  });
});

describe('current-version reconciliation safety', () => {
  it('preserves a blocked current B when the event for older A is delivered late', async () => {
    const doc = await seed({ moderationStatus: 'blocked', blockReason: 'explicit', moderationETag: 'etag-b' });
    h.getMetadata.mockResolvedValue({ etag: '"etag-b"' });

    await recordLandedObject(doc._id, 'uploads/f.png', logger);

    expect(await claimModerationScan(doc._id, new Date())).toBeNull();
    expect(await FabFile.findById(doc._id).lean()).toMatchObject({
      moderationStatus: 'blocked',
      moderationETag: 'etag-b',
      blockReason: 'explicit',
    });
  });

  it('preserves a terminal verdict when HEAD fails, so the landing can retry', async () => {
    const doc = await seed({ moderationStatus: 'blocked', moderationETag: 'etag-b' });
    h.getMetadata.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(recordLandedObject(doc._id, 'uploads/f.png', logger)).rejects.toThrow('storage unavailable');
    expect((await FabFile.findById(doc._id).lean())?.moderationStatus).toBe('blocked');
  });

  it.each([
    { delayedTag: 'etag-a', lostRaces: 0 },
    { delayedTag: 'etag-c', lostRaces: 1 },
  ])('preserves the newer block when a held HEAD resolves $delayedTag', async ({ delayedTag, lostRaces }) => {
    const doc = await seed({ moderationStatus: 'clean', moderationETag: 'etag-a' });
    let releaseHead: ((head: { etag: string }) => void) | undefined;
    h.getMetadata.mockImplementationOnce(
      () =>
        new Promise<{ etag: string }>(resolve => {
          releaseHead = resolve;
        })
    );
    const delayed = recordLandedObject(doc._id, 'uploads/f.png', logger);
    await vi.waitFor(() => expect(h.getMetadata).toHaveBeenCalledTimes(1), { timeout: MONGO_TEST_TIMEOUT_MS });

    h.getMetadata.mockResolvedValue({ etag: 'etag-b' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);
    const claimedAt = new Date();
    expect(await claimModerationScan(doc._id, claimedAt)).not.toBeNull();
    expect(
      await writeModerationVerdict(doc._id, claimedAt, { moderationStatus: 'blocked', blockReason: 'explicit' })
    ).toBe(true);

    // Same-tag HEAD is a safe no-op; a different stale HEAD loses its guarded update and the
    // re-read against current storage settles without touching the newer verdict.
    logger.warn.mockClear();
    const completion = expect(delayed).resolves.toBeUndefined();
    if (!releaseHead) throw new Error('HEAD did not start');
    releaseHead({ etag: delayedTag });
    await completion;
    expect(logger.warn).toHaveBeenCalledTimes(lostRaces);
    expect(await FabFile.findById(doc._id).lean()).toMatchObject({
      moderationStatus: 'blocked',
      moderationETag: 'etag-b',
    });
    expect(await claimModerationScan(doc._id, new Date())).toBeNull();
  });
});

describe('moderation version ABA protection', () => {
  it('rejects a held HEAD B after a newer A -> B -> A cycle finishes blocked', async () => {
    const doc = await seed({ moderationStatus: 'clean', moderationETag: 'etag-a' });
    let releaseHead: ((head: { etag: string }) => void) | undefined;
    h.getMetadata.mockImplementationOnce(
      () =>
        new Promise<{ etag: string }>(resolve => {
          releaseHead = resolve;
        })
    );
    const delayed = recordLandedObject(doc._id, 'uploads/f.png', logger);
    await vi.waitFor(() => expect(h.getMetadata).toHaveBeenCalledTimes(1), { timeout: MONGO_TEST_TIMEOUT_MS });

    h.getMetadata.mockResolvedValue({ etag: 'etag-b' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);
    const firstClaim = new Date('2026-10-20T00:00:00Z');
    expect(await claimModerationScan(doc._id, firstClaim)).not.toBeNull();
    expect(await writeModerationVerdict(doc._id, firstClaim, { moderationStatus: 'blocked' })).toBe(true);

    h.getMetadata.mockResolvedValue({ etag: 'etag-a' });
    await recordLandedObject(doc._id, 'uploads/f.png', logger);
    const secondClaim = new Date('2026-10-20T00:00:01Z');
    expect(await claimModerationScan(doc._id, secondClaim)).not.toBeNull();
    expect(
      await writeModerationVerdict(doc._id, secondClaim, { moderationStatus: 'blocked', blockReason: 'explicit' })
    ).toBe(true);

    const settled = expect(delayed).resolves.toBeUndefined();
    if (!releaseHead) throw new Error('HEAD did not start');
    releaseHead({ etag: 'etag-b' });
    await settled;
    expect(await FabFile.findById(doc._id).lean()).toMatchObject({
      moderationStatus: 'blocked',
      moderationETag: 'etag-a',
      moderationRevision: 2,
    });
  });
});
