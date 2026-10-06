import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { DataLakeModel, dataLakeAccessGrantRepository, dataLakeRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { lakeConfigAuditDb } from './lakeConfigAuditDb';

/**
 * The claim the mocked unit suites cannot pin: against real repositories and indexes, a deleted
 * lake keeps reserving its slug (preview and create both move to "-1") while no longer resolving
 * by it, and the deleted lake keeps its original slug for restore.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await DataLakeModel.ensureIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  await DataLakeModel.ensureIndexes();
});

const USER = '5f9d88b8c1d2a30017a1c333';
const adapters = {
  db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository, ...lakeConfigAuditDb },
};
const create = (fileTagPrefix: string) =>
  dataLakeService.createDataLake(USER, { name: 'Vendor Contracts', slug: 'vendor-contracts', fileTagPrefix }, adapters);

describe('deleted lake slug reservation (real mongod)', () => {
  it('create -> delete -> preview and create both land on "-1"; the deleted lake keeps its slug', async () => {
    const first = await create('vc:');
    expect(first.slug).toBe('vendor-contracts');
    await dataLakeRepository.update({ id: first.id, status: 'deleted' });

    await expect(dataLakeRepository.findBySlug('vendor-contracts')).resolves.toBeNull();
    await expect(dataLakeService.previewDataLakeSlug(adapters.db, 'Vendor Contracts')).resolves.toBe(
      'vendor-contracts-1'
    );

    const second = await create('vc2:');
    expect(second.slug).toBe('vendor-contracts-1');
    expect(await dataLakeRepository.findById(first.id)).toMatchObject({ slug: 'vendor-contracts', status: 'deleted' });
  });
});
