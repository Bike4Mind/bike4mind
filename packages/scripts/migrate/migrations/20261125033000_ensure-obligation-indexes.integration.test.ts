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
  await ObligationModel.createCollection();
  await ObligationModel.collection.deleteMany({});
  await ObligationModel.collection.dropIndexes();
});

const builtIndexes = async () =>
  (await ObligationModel.collection.indexes()).filter(index => INDEXES.includes(index.name ?? ''));

const uniqueFileIndex = async () => (await builtIndexes()).find(index => index.name === UNIQUE_FILE_INDEX);

const buildPartialUniqueFileIndex = () =>
  ObligationModel.collection.createIndex(
    { userId: 1, fileId: 1 },
    { unique: true, partialFilterExpression: { fileId: { $type: 'string' } } }
  );

describe('ensure-obligation-indexes migration (real DB)', () => {
  it('builds the three indexes and runs again without error', async () => {
    await migration.up();
    await migration.up();

    const built = await builtIndexes();
    expect(built.map(index => index.name).sort()).toEqual(INDEXES);
    expect((await uniqueFileIndex())?.unique).toBe(true);
  });

  it('builds the indexes when the collection does not exist yet', async () => {
    await ObligationModel.collection.drop();

    await migration.up();

    expect((await builtIndexes()).map(index => index.name).sort()).toEqual(INDEXES);
  });

  it('replaces a unique file index that carries a partial filter, keeping stored rows', async () => {
    await buildPartialUniqueFileIndex();
    await ObligationModel.collection.insertMany([
      { userId: 'user-1', fileId: 'file-1' },
      { userId: 'user-1', fileId: 'file-2' },
      { userId: 'user-2', fileId: 'file-1' },
      // Outside the partial filter, and alone for its user, so the full index still accepts it.
      { userId: 'user-3' },
    ]);

    await migration.up();

    const index = await uniqueFileIndex();
    expect(index?.key).toEqual({ userId: 1, fileId: 1 });
    expect(index?.unique).toBe(true);
    expect(index?.partialFilterExpression).toBeUndefined();
    expect(await ObligationModel.collection.countDocuments()).toBe(4);
  });

  it.each([
    ['non-unique', {}],
    ['sparse', { unique: true, sparse: true }],
    ['collated', { unique: true, collation: { locale: 'en', strength: 2 } }],
  ])('replaces a %s copy of the unique file index', async (_label, options) => {
    await ObligationModel.collection.createIndex({ userId: 1, fileId: 1 }, options);

    await migration.up();

    const index = await uniqueFileIndex();
    expect(index?.unique).toBe(true);
    expect(index?.sparse).toBeUndefined();
    expect(index?.collation).toBeUndefined();
  });

  it('fails with the old index in place when rows the partial filter excluded would collide', async () => {
    await buildPartialUniqueFileIndex();
    const { insertedIds } = await ObligationModel.collection.insertMany([
      { userId: 'user-1' },
      { userId: 'user-1', fileId: null },
      { userId: 'user-2', fileId: 'file-1' },
    ]);

    const failure = await migration.up().then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('rows share a user and file');
    expect(message).toContain(String(insertedIds[0]));
    expect(message).toContain(String(insertedIds[1]));
    expect(message).not.toContain(String(insertedIds[2]));
    expect((await uniqueFileIndex())?.partialFilterExpression).toEqual({ fileId: { $type: 'string' } });
  });

  it('names the duplicate rows on a rerun after the unique index was already dropped', async () => {
    const { insertedIds } = await ObligationModel.collection.insertMany([
      { userId: 'user-1', fileId: 'file-1' },
      { userId: 'user-1', fileId: 'file-1' },
    ]);

    await expect(migration.up()).rejects.toThrow(String(insertedIds[1]));
    expect(await uniqueFileIndex()).toBeUndefined();
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
    expect((await uniqueFileIndex())?.unique).toBe(true);
    dropIndex.mockRestore();
  });
});
