import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { SystemPrompt, systemPromptRepository } from './SystemPromptModel';
import { SystemPromptHistory } from './SystemPromptHistoryModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await SystemPrompt.syncIndexes();
  await SystemPromptHistory.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await SystemPrompt.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
  await SystemPromptHistory.deleteMany({});
});

const upsert = (promptId: string) =>
  systemPromptRepository.upsertPrompt({
    promptId,
    name: 'Switch Probe',
    description: 'A DB-only probe prompt',
    content: 'hello',
    category: 'general',
    tags: [],
    variables: [],
    enabled: true,
    createdBy: 'admin-1',
    lastUpdatedBy: 'admin-1',
    lastUpdatedByName: 'Admin',
  } as Parameters<typeof systemPromptRepository.upsertPrompt>[0]);

// Inserted through the collection so the history row can hold content the schema would reject,
// as rows written before the save-version length cap can.
const insertHistoryVersion = (promptId: string, version: number, content: string) =>
  SystemPromptHistory.collection.insertOne({
    promptId,
    version,
    content,
    name: 'Switch Probe',
    description: 'A DB-only probe prompt',
    category: 'general',
    tags: [],
    variables: [],
    createdBy: 'admin-1',
    createdByName: 'Admin',
    createdAt: new Date(),
  });

describe('systemPromptRepository.switchVersion', () => {
  it('switches to a stored version whose content is within the limit', async () => {
    await upsert('switch-ok');
    await insertHistoryVersion('switch-ok', 2, 'within the limit');

    const updated = await systemPromptRepository.switchVersion('switch-ok', 2, 'admin-1', 'Admin');

    expect(updated?.activeVersion).toBe(2);
    expect(updated?.content).toBe('within the limit');
  });

  it('rejects a stored version over 50000 chars and leaves the prompt unchanged', async () => {
    await upsert('switch-long');
    await insertHistoryVersion('switch-long', 2, 'x'.repeat(50001));

    await expect(systemPromptRepository.switchVersion('switch-long', 2, 'admin-1', 'Admin')).rejects.toThrow();

    const prompt = await systemPromptRepository.findByPromptId('switch-long');
    expect(prompt?.activeVersion).toBe(1);
    expect(prompt?.content).toBe('hello');
  });
});
