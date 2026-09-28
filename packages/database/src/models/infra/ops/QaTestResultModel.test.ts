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

  it('declares the query indexes', async () => {
    const keys = (await QaTestResult.collection.indexes()).map(i => i.key);
    expect(keys).toContainEqual({ runId: 1 });
    expect(keys).toContainEqual({ testKey: 1, _id: -1 });
  });
});
