import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';
import { AdminAiAttemptModel } from './AdminAiOperationsModel';
import migration from '../../../../../scripts/migrate/migrations/20260921241039_ensure-admin-ai-attempt-retention';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  if (!mongoose.connection.db) throw new Error('Local MongoDB did not connect');
  await mongoose.connection.db.admin().command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
  await AdminAiAttemptModel.init();
  await migration.up();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const attempt = (daysOld: number, outcome: 'running' | 'suggestion') => ({
  feature: 'feedbackTriage',
  policyVersion: 'test',
  outcome,
  calls: 1,
  knownCostUsd: 0.01,
  costUnknown: false,
  startedAt: new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000),
  ...(outcome === 'suggestion' ? { finishedAt: new Date() } : {}),
});

describe('AI attempt metadata retention', () => {
  it('installs the 400-day TTL index on an existing database and can run again', async () => {
    await migration.up();
    await migration.up();
    const indexes = await AdminAiAttemptModel.collection.indexes();
    expect(indexes.find(index => index.name === 'admin_ai_attempt_retention')).toMatchObject({
      key: { startedAt: 1 },
      expireAfterSeconds: 34_560_000,
    });
  });

  it('expires old completed and interrupted attempts while retaining newer metadata', async () => {
    const old = await AdminAiAttemptModel.create([attempt(401, 'suggestion'), attempt(401, 'running')]);
    const fresh = await AdminAiAttemptModel.create(attempt(399, 'suggestion'));
    await expect
      .poll(() => AdminAiAttemptModel.countDocuments({ _id: { $in: old.map(row => row._id) } }), {
        timeout: MONGO_TEST_TIMEOUT_MS,
        interval: 250,
      })
      .toBe(0);
    expect(await AdminAiAttemptModel.findById(fresh._id).lean()).toMatchObject({
      calls: 1,
      knownCostUsd: 0.01,
      outcome: 'suggestion',
    });
  });
});
