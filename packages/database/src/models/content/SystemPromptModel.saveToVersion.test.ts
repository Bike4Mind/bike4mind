import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { SystemPrompt, systemPromptRepository } from './SystemPromptModel';
import { SystemPromptHistory, systemPromptHistoryRepository } from './SystemPromptHistoryModel';

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

const seed = async (promptId: string) => {
  await systemPromptRepository.upsertPrompt({
    promptId,
    name: 'Probe',
    description: 'A DB-only probe prompt',
    content: 'original',
    category: 'general',
    tags: [],
    variables: [],
    enabled: true,
    createdBy: 'admin-1',
    lastUpdatedBy: 'admin-1',
    lastUpdatedByName: 'Admin',
  } as Parameters<typeof systemPromptRepository.upsertPrompt>[0]);
  await systemPromptRepository.updateActiveVersion(promptId, 1);
};

describe('systemPromptRepository.saveToVersion content length', () => {
  it('saves content at the 50,000 character limit', async () => {
    await seed('len-ok');
    const content = 'x'.repeat(50000);

    await systemPromptRepository.saveToVersion('len-ok', 1, { content }, 'admin-1', 'Admin');

    expect((await systemPromptHistoryRepository.getVersion('len-ok', 1))?.content).toBe(content);
    expect((await systemPromptRepository.findByPromptId('len-ok'))?.content).toBe(content);
  });

  it('rejects content over 50,000 characters and stores nothing', async () => {
    await seed('len-over');

    await expect(
      systemPromptRepository.saveToVersion('len-over', 1, { content: 'x'.repeat(50001) }, 'admin-1', 'Admin')
    ).rejects.toThrow(/content/);

    expect((await systemPromptHistoryRepository.getVersion('len-over', 1))?.content).toBe('original');
    expect((await systemPromptRepository.findByPromptId('len-over'))?.content).toBe('original');
  });

  it('keeps the stored name, description and category when the editor sends them blank', async () => {
    await seed('blank-fields');

    await systemPromptRepository.saveToVersion(
      'blank-fields',
      1,
      { content: 'edited', name: '', description: '', category: '' },
      'admin-1',
      'Admin'
    );

    const history = await systemPromptHistoryRepository.getVersion('blank-fields', 1);
    expect(history).toMatchObject({ content: 'edited', name: 'Probe', category: 'general' });
    expect(history?.description).toBe('A DB-only probe prompt');
    expect((await systemPromptRepository.findByPromptId('blank-fields'))?.category).toBe('general');
  });

  it('rejects a description over 2,000 characters and stores nothing', async () => {
    await seed('desc-over');

    await expect(
      systemPromptRepository.saveToVersion(
        'desc-over',
        1,
        { content: 'new', description: 'd'.repeat(2001) },
        'admin-1',
        'Admin'
      )
    ).rejects.toThrow(/description/);

    expect((await systemPromptHistoryRepository.getVersion('desc-over', 1))?.content).toBe('original');
  });
});
