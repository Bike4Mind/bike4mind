import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import SystemPrompt from './SystemPromptModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await SystemPrompt.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await SystemPrompt.collection.deleteMany({});
});

const prompt = (over: Record<string, unknown> = {}) => ({
  promptId: 'summarizer',
  name: 'Summarizer',
  description: 'Summarizes things',
  content: 'Summarize the following',
  category: 'general',
  createdBy: 'u1',
  lastUpdatedBy: 'u1',
  lastUpdatedByName: 'User One',
  ...over,
});

// The partial filter must key on `deletedAt: null`, not `$exists: false`: softDeletePlugin gives
// every document `deletedAt: null`, so the old `$exists: false` form indexed zero documents and
// let duplicate promptIds through.
describe('SystemPrompt promptId unique index', () => {
  it('rejects a second live prompt with the same promptId', async () => {
    await SystemPrompt.create(prompt());
    await expect(SystemPrompt.create(prompt({ name: 'Duplicate' }))).rejects.toMatchObject({ code: 11000 });
  });

  it('allows a different promptId', async () => {
    await SystemPrompt.create(prompt());
    await expect(SystemPrompt.create(prompt({ promptId: 'translator' }))).resolves.toBeDefined();
  });

  it('allows re-creating a promptId whose previous row was soft-deleted', async () => {
    const created = await SystemPrompt.create(prompt());
    await SystemPrompt.collection.updateOne({ _id: created._id }, { $set: { deletedAt: new Date() } });

    await expect(SystemPrompt.create(prompt({ name: 'Recreated' }))).resolves.toBeDefined();
  });

  it('does not constrain soft-deleted rows against each other', async () => {
    await SystemPrompt.collection.insertMany([
      { ...prompt(), deletedAt: new Date() },
      { ...prompt(), deletedAt: new Date() },
    ]);

    expect(await SystemPrompt.collection.countDocuments({ promptId: 'summarizer' })).toBe(2);
  });
});
