import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, Organization, Session } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../database/src/__test__/createMongoServer';
import migration from './20261114101042_drop-obsolete-organization-retention-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const generatedOldName = 'sourceMetadata.retentionOrganizationId_1_deletedAt_1_createdAt_1__id_1';
const orgOldName = 'personal_1_retentionLastSweptAt_1__id_1';
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
  for (const model of [Session, FabFile, Organization]) {
    await model.collection.drop().catch(error => {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
    });
  }
  // Actual earlier full/default-name definitions are retained as conservative non-retention controls.
  await Session.collection.createIndex({ retentionOrganizationId: 1, deletedAt: 1, _id: 1 });
  await FabFile.collection.createIndex({ organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 });
  await Organization.collection.createIndex({ personal: 1, retentionLastSweptAt: 1, _id: 1 });
  await Session.collection.createIndex(
    { retentionOrganizationId: 1, deletedAt: 1, _id: 1 },
    { name: 'retention_sessions_partial', partialFilterExpression: { retentionOrganizationId: { $type: 'string' } } }
  );
  await FabFile.collection.createIndex(
    { organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 },
    { name: 'retention_files_partial', partialFilterExpression: { organizationId: { $type: 'string' } } }
  );
  await FabFile.collection.createIndex(
    { 'sourceMetadata.retentionOrganizationId': 1, deletedAt: 1, createdAt: 1, _id: 1 },
    { partialFilterExpression: { 'sourceMetadata.retentionOrganizationId': { $type: 'string' } } }
  );
  await FabFile.collection.createIndex({ name: 1 }, { name: 'foreign_control' });
});

it('removes only the four verified obsolete indexes and is repeatable after the predecessor was stamped', async () => {
  await migration.up();
  await migration.up();
  const sessions = await Session.collection.indexes();
  const files = await FabFile.collection.indexes();
  const organizations = await Organization.collection.indexes();
  expect(sessions.map(index => index.name)).not.toContain('retention_sessions_partial');
  expect(files.map(index => index.name)).not.toContain('retention_files_partial');
  expect(files.map(index => index.name)).not.toContain(generatedOldName);
  expect(organizations.map(index => index.name)).not.toContain(orgOldName);
  expect(sessions.map(index => index.name)).toContain('retentionOrganizationId_1_deletedAt_1__id_1');
  expect(files.map(index => index.name)).toContain('organizationId_1_deletedAt_1_createdAt_1__id_1');
  expect(files.map(index => index.name)).toContain('foreign_control');
  expect(sessions.find(index => index.name === 'retention_sessions_present')).toMatchObject({
    partialFilterExpression: { retentionOrganizationId: { $exists: true } },
  });
  expect(files.find(index => index.name === 'retention_files_present')).toMatchObject({
    partialFilterExpression: { organizationId: { $exists: true } },
  });
  expect(files.find(index => index.name === 'retention_generated_files_present')).toMatchObject({
    partialFilterExpression: { 'sourceMetadata.retentionOrganizationId': { $exists: true } },
  });
  expect(organizations.find(index => index.name === 'retention_opted_in_sweep')).toMatchObject({
    partialFilterExpression: { retentionVersion: { $gt: 0 } },
  });
});

it('does not drop anything if replacement creation fails', async () => {
  const failure = new Error('replacement index unavailable');
  vi.spyOn(Session.collection, 'createIndex').mockRejectedValueOnce(failure);
  const sessionDrop = vi.spyOn(Session.collection, 'dropIndex');
  const fileDrop = vi.spyOn(FabFile.collection, 'dropIndex');
  await expect(migration.up()).rejects.toBe(failure);
  expect(sessionDrop).not.toHaveBeenCalled();
  expect(fileDrop).not.toHaveBeenCalled();
});

it('tolerates only an index-not-found race', async () => {
  const drop = Session.collection.dropIndex.bind(Session.collection);
  vi.spyOn(Session.collection, 'dropIndex').mockImplementationOnce(async name => {
    await drop(name);
    throw new mongoose.mongo.MongoServerError({ message: 'already dropped concurrently', code: 27 });
  });
  await expect(migration.up()).resolves.toBeUndefined();
  expect((await Session.collection.indexes()).map(index => index.name)).not.toContain('retention_sessions_partial');
});

it('propagates unexpected index deletion failures', async () => {
  const failure = new mongoose.mongo.MongoServerError({ message: 'permission denied', code: 13 });
  vi.spyOn(Session.collection, 'dropIndex').mockRejectedValueOnce(failure);
  await expect(migration.up()).rejects.toBe(failure);
});

it('preserves an unrecognized definition using a historical name', async () => {
  await Session.collection.dropIndex('retention_sessions_partial');
  await Session.collection.createIndex({ retentionOrganizationId: 1 }, { name: 'retention_sessions_partial' });
  const drop = vi.spyOn(Session.collection, 'dropIndex');
  await expect(migration.up()).rejects.toThrow('unrecognized legacy index');
  expect(drop).not.toHaveBeenCalled();
  expect((await Session.collection.indexes()).find(index => index.name === 'retention_sessions_partial')?.key).toEqual({
    retentionOrganizationId: 1,
  });
});
