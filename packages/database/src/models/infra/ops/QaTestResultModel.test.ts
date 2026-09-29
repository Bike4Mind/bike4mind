import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { QaTestResult } from './QaTestResultModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await QaTestResult.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
afterEach(async () => {
  await QaTestResult.deleteMany({});
});

describe('QaTestResultModel', () => {
  it('stores artifacts', async () => {
    const doc = await QaTestResult.create({
      runId: new mongoose.Types.ObjectId().toHexString(),
      testKey: 'notebook.spec.ts > Notebook > saves',
      title: 'Notebook > saves',
      status: 'failed',
      durationMs: 1200,
      retries: 2,
      error: 'expect(locator).toBeVisible() failed',
      artifacts: [{ kind: 'screenshot', key: 'product-a/1-1/media/test-0/shot.png', bytes: 1000 }],
    });
    const found = await QaTestResult.findById(doc._id).lean();
    expect(found?.artifacts).toEqual([{ kind: 'screenshot', key: 'product-a/1-1/media/test-0/shot.png', bytes: 1000 }]);
  });

  it('rejects an unknown test status', async () => {
    await expect(
      QaTestResult.create({ runId: 'r', testKey: 'k', title: 't', status: 'weird', durationMs: 0, retries: 0 })
    ).rejects.toThrow();
  });

  it('declares the query indexes, with one row per test in a run', async () => {
    const indexes = await QaTestResult.collection.indexes();
    expect(indexes).toContainEqual(expect.objectContaining({ key: { runId: 1, testKey: 1 }, unique: true }));
    expect(indexes.map(i => i.key)).toContainEqual({ testKey: 1, _id: -1 });
  });

  it('rejects a second row for the same test in a run', async () => {
    const row = { runId: 'r', testKey: 'k', title: 't', status: 'passed', durationMs: 0, retries: 0 };
    await QaTestResult.create(row);
    await expect(QaTestResult.create({ ...row })).rejects.toThrow(/duplicate key/);
  });
});
