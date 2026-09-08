import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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

afterEach(async () => {
  await Project.collection.deleteMany({});
});

const project = (over: Record<string, unknown> = {}) => ({
  name: 'Roadmap',
  description: 'Planning',
  userId: 'u1',
  ...over,
});

// Regression for the per-user unique name index: the old `deletedAt: { $exists: false }`
// filter is rejected by Mongo in a partialFilterExpression, so the index silently
// never built. softDeletePlugin defaults deletedAt to null on live rows, so the
// supported `deletedAt: null` form is what indexes them.
describe('Project userId+name unique partial index', () => {
  beforeAll(async () => {
    await Project.syncIndexes();
  });

  it('syncIndexes builds the unique partial index without rejection', async () => {
    const indexes = await Project.collection.indexes();
    const unique = indexes.find(i => i.name === 'userId_1_name_1');
    expect(unique).toBeDefined();
    expect(unique?.unique).toBe(true);
    expect(unique?.partialFilterExpression).toEqual({ deletedAt: null });
  });

  it('rejects a second live project with the same (userId, name)', async () => {
    await Project.create(project());
    await expect(Project.create(project({ description: 'Dup' }))).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same name under a different user', async () => {
    await Project.create(project({ userId: 'u1' }));
    await expect(Project.create(project({ userId: 'u2' }))).resolves.toBeDefined();
  });

  it('allows re-creating a name whose previous row was soft-deleted', async () => {
    const created = await Project.create(project());
    await Project.collection.updateOne({ _id: created._id }, { $set: { deletedAt: new Date() } });

    await expect(Project.create(project({ description: 'Recreated' }))).resolves.toBeDefined();
  });
});
