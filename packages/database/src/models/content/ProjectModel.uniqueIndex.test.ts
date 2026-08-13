import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import Project from './ProjectModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// Regression for the per-user unique name index: the old `deletedAt: { $exists: false }`
// filter is rejected by Mongo in a partialFilterExpression, so the index silently
// never built. softDeletePlugin defaults deletedAt to null on live rows, so the
// supported `deletedAt: null` form is what indexes them.
describe('Project userId+name unique partial index', () => {
  it('syncIndexes builds the unique partial index without rejection', async () => {
    await expect(Project.syncIndexes()).resolves.toBeDefined();
    const indexes = await Project.collection.indexes();
    const unique = indexes.find(i => i.name === 'userId_1_name_1');
    expect(unique).toBeDefined();
    expect(unique?.unique).toBe(true);
    expect(unique?.partialFilterExpression).toEqual({ deletedAt: null });
  });
});
