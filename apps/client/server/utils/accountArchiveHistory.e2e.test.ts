import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { ToolExecutionLog, UsageEvent } from '@bike4mind/database';
import { collectAccountHistoryFromDatabase } from './accountArchiveHistory';

// Real models, so a schema field rename shows up here instead of silently dropping export data.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const usage = (fields: Record<string, unknown>) => ({
  requestId: 'req',
  userId: 'owner',
  ownerId: 'owner',
  ownerType: 'User',
  feature: 'chat',
  provider: 'anthropic',
  model: 'm1',
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0.01,
  creditsCharged: 3,
  ...fields,
});

describe('collectAccountHistoryFromDatabase against real models', () => {
  it('exports the owner rows with every allowlisted field', async () => {
    const timestamp = new Date('2026-01-02T03:04:05.000Z');
    await ToolExecutionLog.create([
      { userId: 'owner', toolName: 'search', timestamp, success: true, executionTimeMs: 42, error: 'secret' },
      { userId: 'other', toolName: 'search', timestamp, success: true, executionTimeMs: 1 },
    ]);
    await UsageEvent.create([
      usage({ requestId: 'r1' }),
      usage({ requestId: 'r2', userId: 'other', ownerId: 'other' }),
    ]);

    const history = await collectAccountHistoryFromDatabase('owner');

    expect(history.toolExecutions).toEqual([
      { toolName: 'search', timestamp: timestamp.toISOString(), success: true, executionTimeMs: 42 },
    ]);
    expect(history.usageEvents).toHaveLength(1);
    expect(history.usageEvents[0]).toEqual({
      feature: 'chat',
      provider: 'anthropic',
      model: 'm1',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
      creditsCharged: 3,
      status: 'ok',
      createdAt: expect.any(String),
    });
  });
});
