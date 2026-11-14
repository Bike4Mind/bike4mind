import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  FabFile,
  GeneratedFileCleanupModel,
  Organization,
  OrganizationGeneratedObject,
  OrganizationRetentionEstimate,
  Session,
} from '@bike4mind/database';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261113185006_ensure-organization-retention-erasure-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

it.each(['original full indexes', 'later partial indexes'])(
  'upgrades %s without rerunning the stamped migration and remains idempotent',
  async previous => {
    await Session.collection.drop().catch(error => {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
    });
    await FabFile.collection.drop().catch(error => {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
    });
    await Session.collection.createIndex(
      { retentionOrganizationId: 1, deletedAt: 1, _id: 1 },
      previous === 'original full indexes'
        ? { name: 'retention_sessions_original' }
        : {
            name: 'retention_sessions_partial',
            partialFilterExpression: { retentionOrganizationId: { $type: 'string' } },
          }
    );
    await FabFile.collection.createIndex(
      { organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 },
      previous === 'original full indexes'
        ? { name: 'retention_files_original' }
        : { name: 'retention_files_partial', partialFilterExpression: { organizationId: { $type: 'string' } } }
    );
    await migration.up();
    await migration.up();
    expect(
      (await Organization.collection.indexes()).find(index => index.name === 'retention_opted_in_sweep')
    ).toMatchObject({
      key: { personal: 1, retentionLastSweptAt: 1, _id: 1 },
      partialFilterExpression: { retentionVersion: { $gt: 0 } },
    });
    const sessions = await Session.collection.indexes();
    expect(sessions.find(index => index.name === 'retention_sessions_present')).toMatchObject({
      key: { retentionOrganizationId: 1, deletedAt: 1, _id: 1 },
      partialFilterExpression: { retentionOrganizationId: { $exists: true } },
    });
    const files = await FabFile.collection.indexes();
    expect(files.find(index => index.name === 'retention_files_present')).toMatchObject({
      key: { organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 },
      partialFilterExpression: { organizationId: { $exists: true } },
    });
    expect(files.find(index => index.name === 'retention_generated_files_present')).toMatchObject({
      key: { 'sourceMetadata.retentionOrganizationId': 1, deletedAt: 1, createdAt: 1, _id: 1 },
      partialFilterExpression: { 'sourceMetadata.retentionOrganizationId': { $exists: true } },
    });
    expect((await OrganizationGeneratedObject.collection.indexes()).some(index => index.key.userId === 1)).toBe(true);
    expect((await OrganizationRetentionEstimate.collection.indexes()).some(index => index.key.actorUserId === 1)).toBe(
      true
    );
    expect((await GeneratedFileCleanupModel.collection.indexes()).some(index => index.key.filePath === 1)).toBe(true);
  }
);
