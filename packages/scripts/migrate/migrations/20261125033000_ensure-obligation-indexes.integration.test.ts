import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { ObligationModel } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261125033000_ensure-obligation-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const UNIQUE_FILE_INDEX = 'userId_1_fileId_1';
const INDEXES = ['userId_1__id_-1', UNIQUE_FILE_INDEX, 'userId_1_status_1_dueDate_1'];

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await ObligationModel.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await ObligationModel.collection.dropIndexes();
});

const builtIndexes = async () =>
  (await ObligationModel.collection.indexes()).filter(index => INDEXES.includes(index.name ?? ''));

describe('ensure-obligation-indexes migration (real DB)', () => {
  it('builds the three indexes and runs again without error', async () => {
    await migration.up();
    await migration.up();

    const built = await builtIndexes();
    expect(built.map(index => index.name).sort()).toEqual(INDEXES);
    expect(built.find(index => index.name === UNIQUE_FILE_INDEX)?.unique).toBe(true);
  });

  it('replaces a unique file index that was built with different options', async () => {
    await ObligationModel.collection.createIndex(
      { userId: 1, fileId: 1 },
      { unique: true, partialFilterExpression: { fileId: { $type: 'string' } } }
    );

    await migration.up();

    const uniqueFileIndex = (await builtIndexes()).find(index => index.name === UNIQUE_FILE_INDEX);
    expect(uniqueFileIndex?.key).toEqual({ userId: 1, fileId: 1 });
    expect(uniqueFileIndex?.unique).toBe(true);
    expect(uniqueFileIndex?.partialFilterExpression).toBeUndefined();
  });

  it('rethrows a conflict on another index and leaves the unique file index in place', async () => {
    await ObligationModel.collection.createIndex({ userId: 1, fileId: 1 }, { unique: true });
    await ObligationModel.collection.createIndex(
      { userId: 1, status: 1, dueDate: 1 },
      { partialFilterExpression: { status: 'pending' } }
    );
    const dropIndex = vi.spyOn(ObligationModel.collection, 'dropIndex');

    await expect(migration.up()).rejects.toMatchObject({ code: expect.any(Number) });

    expect(dropIndex).not.toHaveBeenCalled();
    expect((await builtIndexes()).find(index => index.name === UNIQUE_FILE_INDEX)?.unique).toBe(true);
    dropIndex.mockRestore();
  });
});
