import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { AutoContainmentDecisionModel } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261124112619_separate-auto-containment-decisions-by-tier';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const collection = () => {
  const database = mongoose.connection.db;
  if (!database) throw new Error('Test database unavailable');
  return database.collection('AutoContainmentDecision');
};
const legacy = (extra: Record<string, unknown> = {}) => ({
  detectionId: 'detection',
  revision: 0,
  assessmentId: 'assessment',
  mode: 'enforce',
  outcome: 'contained',
  userIds: ['user'],
  confidence: 0.97,
  reason: 'evidence',
  batchId: null,
  error: null,
  decidedAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});
const indexes = () => collection().indexes();
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await collection()
    .drop()
    .catch((error: unknown) => {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
    });
  await mongoose.connection.db!.createCollection('AutoContainmentDecision');
});

describe('tier-separated containment claim migration', () => {
  it.each([{ detectionId: 1 } as const, { detectionId: 1, revision: 1 } as const])(
    'replaces the actual obsolete key %j while preserving ids, timestamps and serving indexes',
    async oldKey => {
      await collection().createIndex(oldKey, { unique: true, name: 'custom_legacy_guard' });
      await collection().createIndex({ decidedAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });
      await collection().createIndex({ outcome: 1, decidedAt: -1 });
      const original = legacy();
      const { insertedId } = await collection().insertOne(original);
      await migration.up();
      await migration.up();
      expect(await collection().findOne({ _id: insertedId })).toEqual({
        _id: insertedId,
        ...original,
        tier: 'contain',
        claimClass: null,
      });
      const after = await indexes();
      expect(after.some(index => index.name === 'custom_legacy_guard')).toBe(false);
      expect(after).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'detection_revision_claim_class_unique',
            key: { detectionId: 1, revision: 1, claimClass: 1 },
            unique: true,
          }),
          expect.objectContaining({ key: { decidedAt: 1 }, expireAfterSeconds: 365 * 24 * 60 * 60 }),
          expect.objectContaining({ key: { outcome: 1, decidedAt: -1 } }),
        ])
      );
      await collection().insertOne(legacy({ tier: 'limit', outcome: 'intervened', claimClass: 'graduated' }));
      await expect(collection().insertOne(legacy({ tier: 'review', claimClass: 'graduated' }))).rejects.toMatchObject({
        code: 11000,
      });
      expect(await collection().countDocuments({})).toBe(2);
      await migration.down();
      expect(await collection().countDocuments({})).toBe(2);
    }
  );

  it('normalizes null legacy tiers and supports a database with no old guard', async () => {
    const { insertedId } = await collection().insertOne(legacy({ tier: null }));
    await migration.up();
    expect(await collection().findOne({ _id: insertedId })).toMatchObject({ tier: 'contain', claimClass: null });
    await collection().insertOne(legacy({ tier: 'review', claimClass: 'graduated' }));
    await expect(collection().insertOne(legacy({ tier: 'contain', claimClass: null }))).rejects.toMatchObject({
      code: 11000,
    });
  });

  it.each([{ tier: 'unexpected' }, { tier: ['limit'] }])(
    'rejects unknown or non-scalar tier $tier before removing the old guard',
    async ({ tier }) => {
      await collection().createIndex({ detectionId: 1, revision: 1 }, { unique: true, name: 'legacy' });
      await collection().insertOne(legacy({ tier }));
      await expect(migration.up()).rejects.toThrow('Unrecognized legacy containment tier');
      expect((await indexes()).some(index => index.name === 'legacy')).toBe(true);
    }
  );

  it('refuses different graduated tiers sharing one claim class without deleting or merging records', async () => {
    await collection().insertMany([legacy({ tier: 'review', claimClass: 'graduated' }), legacy({ tier: 'review' })]);
    await expect(migration.up()).rejects.toThrow('Duplicate containment claim class');
    expect(await collection().countDocuments({})).toBe(2);
    expect((await indexes()).some(index => index.name === 'detection_revision_claim_class_unique')).toBe(false);
  });

  it('refuses unfamiliar obsolete index options', async () => {
    await collection().createIndex({ detectionId: 1 }, { unique: true, sparse: true, name: 'unfamiliar' });
    await expect(migration.up()).rejects.toThrow('Unrecognized containment index options');
    expect((await indexes()).some(index => index.name === 'unfamiliar')).toBe(true);
  });

  it('deduplicates missing-class old writers against null-class Contain writers after migration', async () => {
    await migration.up();
    // An old writer arrives after the backfill, so this row has neither tier nor claimClass.
    await collection().insertOne(legacy());
    await expect(collection().insertOne(legacy({ tier: 'contain', claimClass: null }))).rejects.toMatchObject({
      code: 11000,
    });
    await collection().insertOne(legacy({ tier: 'limit', claimClass: 'graduated' }));
    await expect(collection().insertOne(legacy({ tier: 'review', claimClass: 'graduated' }))).rejects.toMatchObject({
      code: 11000,
    });
    // The opposite arrival order also keeps the legacy writer in the same unique slot.
    await collection().insertOne(legacy({ revision: 1, tier: 'contain', claimClass: null }));
    await expect(collection().insertOne(legacy({ revision: 1 }))).rejects.toMatchObject({ code: 11000 });
    const direct = await AutoContainmentDecisionModel.create({
      ...legacy(),
      detectionId: 'direct-model',
      tier: 'review',
    });
    expect(direct.claimClass).toBe('graduated');
  });

  it('uses the same replacement key as the model declaration', async () => {
    expect(AutoContainmentDecisionModel.schema.indexes()).toContainEqual([
      { detectionId: 1, revision: 1, claimClass: 1 },
      expect.objectContaining({ unique: true, name: 'detection_revision_claim_class_unique' }),
    ]);
  });
});
