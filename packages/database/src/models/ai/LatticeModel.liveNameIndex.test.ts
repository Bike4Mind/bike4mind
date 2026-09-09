import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { LatticeModel } from './LatticeModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// Regression for the live userId+name index: the old `deletedAt: { $exists: false }`
// filter is rejected by Mongo in a partialFilterExpression, so the index silently
// never built. `deletedAt: null` is the supported form. The index is intentionally
// NOT unique (see LatticeModel.ts), so this guards that it builds and stays non-unique.
describe('Lattice userId+name live-name index', () => {
  it('syncIndexes builds the partial index without rejection', async () => {
    await expect(LatticeModel.syncIndexes()).resolves.toBeDefined();
    const indexes = await LatticeModel.collection.indexes();
    const idx = indexes.find(i => i.name === 'userId_1_name_1');
    expect(idx).toBeDefined();
    expect(idx?.unique).toBeFalsy();
    expect(idx?.partialFilterExpression).toEqual({ deletedAt: null });
  });
});
