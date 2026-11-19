import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { Organization, organizationRepository } from './OrganizationModel';
import { createMongoReplSet, settleAutoIndexBuilds, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
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
  await Organization.collection.deleteMany({});
});
afterEach(() => vi.restoreAllMocks());

function holdNextSnapshot() {
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const find = Organization.findById.bind(Organization);
  vi.spyOn(Organization, 'findById').mockImplementationOnce((...args) => {
    const query = find(...args);
    const execute = query.exec.bind(query);
    vi.spyOn(query, 'exec').mockImplementationOnce(async () => {
      const snapshot = await execute();
      read.resolve();
      await release.promise;
      return snapshot;
    });
    return query;
  });
  return { read: read.promise, release: release.resolve };
}

it('retries an old plan snapshot without overwriting a concurrent admin override', async () => {
  const org = await Organization.create({
    name: 'org',
    userId: 'owner',
    storageLimit: 7500,
    seats: 7,
    currentCredits: 123,
  });
  const held = holdNextSnapshot();
  const pending = organizationRepository.setPlanStorageLimit(org.id, 50_000);
  await held.read;
  try {
    await organizationRepository.setStorageLimitOverride(org.id, 1234);
  } finally {
    held.release();
  }
  expect(await pending).toBe(true);
  expect(await Organization.findById(org.id).lean()).toMatchObject({
    storageLimit: 1234,
    storageLimitOverride: 1234,
    planStorageLimit: 50_000,
    seats: 7,
    currentCredits: 123,
    __v: 2,
  });
});

it('clears an override to the latest plan after a concurrent plan write', async () => {
  const org = await Organization.create({
    name: 'org',
    userId: 'owner',
    storageLimit: 1234,
    storageLimitOverride: 1234,
    planStorageLimit: 20_000,
  });
  const held = holdNextSnapshot();
  const pending = organizationRepository.setStorageLimitOverride(org.id, null);
  await held.read;
  try {
    await organizationRepository.setPlanStorageLimit(org.id, 50_000);
  } finally {
    held.release();
  }
  expect(await pending).toMatchObject({ storageLimit: 50_000, storageLimitOverride: null, planStorageLimit: 50_000 });
  expect(await Organization.findById(org.id).lean()).toMatchObject({
    storageLimit: 50_000,
    storageLimitOverride: null,
    planStorageLimit: 50_000,
    __v: 2,
  });
});

it('keeps quota reads and writes inside the caller transaction and rolls back its version fence', async () => {
  const id = new mongoose.Types.ObjectId();
  await Organization.collection.insertOne({ _id: id, name: 'legacy', userId: 'owner', storageLimit: 7500, seats: 7 });
  await expect(
    withTransaction(async () => {
      expect(await organizationRepository.setPlanStorageLimit(id.toString(), 50_000)).toBe(true);
      expect(await organizationRepository.setStorageLimitOverride(id.toString(), 0)).toMatchObject({
        storageLimit: 0,
        planStorageLimit: 50_000,
      });
      expect((await Organization.findById(id).lean())?.__v).toBe(2);
      throw new Error('abort quota transaction');
    })
  ).rejects.toThrow('abort quota transaction');
  const stored = await Organization.collection.findOne({ _id: id });
  expect(stored).toMatchObject({ storageLimit: 7500, seats: 7 });
  expect(Object.hasOwn(stored ?? {}, 'storageLimitOverride')).toBe(false);
  expect(Object.hasOwn(stored ?? {}, 'planStorageLimit')).toBe(false);
  expect(Object.hasOwn(stored ?? {}, '__v')).toBe(false);
});
