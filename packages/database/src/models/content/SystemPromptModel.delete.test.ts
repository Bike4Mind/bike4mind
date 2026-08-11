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
  // Both models' indexes are built: the live-unique promptId index is what makes the
  // recreate-after-delete case below meaningful.
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
    name: 'Probe',
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

describe('systemPromptRepository.deletePrompt', () => {
  it('deletes a prompt whose current version is already in history', async () => {
    // upsertPrompt writes v1 to history, so the deletion snapshot collides with the
    // unique {promptId, version} index unless the history write replaces in place.
    await upsert('qa-probe');
    expect(await systemPromptHistoryRepository.getVersion('qa-probe', 1)).toBeTruthy();

    const result = await systemPromptRepository.deletePrompt('qa-probe', 'admin-1', 'Admin');

    expect(result).toEqual({ deleted: true, historyPreserved: true });
    expect(await systemPromptRepository.findByPromptId('qa-probe')).toBeFalsy();

    const history = await systemPromptHistoryRepository.getVersions('qa-probe');
    expect(history).toHaveLength(1);
    expect(history[0].changeReason).toBe('Deleted');
  });

  it('removes the row outright rather than soft-deleting it', async () => {
    await upsert('qa-probe');
    await systemPromptRepository.deletePrompt('qa-probe', 'admin-1', 'Admin');

    expect(await SystemPrompt.collection.countDocuments({ promptId: 'qa-probe' })).toBe(0);
  });

  it('allows recreating and re-editing a prompt with a previously deleted id', async () => {
    await upsert('qa-probe');
    await systemPromptRepository.deletePrompt('qa-probe', 'admin-1', 'Admin');

    const recreated = await upsert('qa-probe');
    expect(recreated.promptId).toBe('qa-probe');

    const updated = await systemPromptRepository.updatePrompt('qa-probe', { content: 'goodbye' }, 'admin-1', 'Admin');
    expect(updated?.content).toBe('goodbye');
  });

  it('reports nothing deleted when the prompt does not exist', async () => {
    expect(await systemPromptRepository.deletePrompt('missing', 'admin-1', 'Admin')).toEqual({
      deleted: false,
      historyPreserved: false,
    });
  });
});

describe('systemPromptRepository.resetToDefault', () => {
  it('still succeeds when the current version is already in history', async () => {
    await upsert('qa-probe');

    const result = await systemPromptRepository.resetToDefault('qa-probe', 'admin-1', 'Admin');

    expect(result).toEqual({ deleted: true, historyPreserved: true });
    expect(await systemPromptRepository.findByPromptId('qa-probe')).toBeFalsy();
    expect((await systemPromptHistoryRepository.getVersion('qa-probe', 1))?.changeReason).toBe('Reset to default');
  });
});
