/**
 * Real-Mongo check that the alert analysis cache lands on the quest by `_id`. Quest has no
 * top-level `requestId`, so the old `{ requestId }` filter matched nothing (and scanned).
 *
 * Consumes the built dist (`pnpm turbo:core:build`); integration lane only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest } from '@bike4mind/database';
import { cacheTelemetryAnalysisOnQuest, type CachedTelemetryAnalysis } from './telemetryAnalysisCache';

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
afterEach(async () => {
  await Quest.deleteMany({}, { hardDelete: true });
});

const cached: CachedTelemetryAnalysis = {
  analysis: { summary: 'slow', findings: ['f1'], recommendations: ['r1'], estimatedImpact: 'low' },
  analysisSource: 'auto-rule-based',
  historicalBaselines: null,
  cachedAt: '2026-01-01T00:00:00.000Z',
};

const seedQuest = () =>
  Quest.create({ sessionId: 'session1', prompt: 'hello', type: 'message', timestamp: new Date() });
const readCached = async (id: unknown) =>
  (await Quest.findOne({ _id: id }).lean())?.promptMeta?.contextTelemetry?.cachedAnalysis;

describe('cacheTelemetryAnalysisOnQuest', () => {
  it('writes cachedAnalysis onto the quest by its string id and leaves other quests alone', async () => {
    const quest = await seedQuest();
    const other = await seedQuest();

    const result = await cacheTelemetryAnalysisOnQuest(String(quest._id), cached);

    expect(result).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    expect((await readCached(quest._id))?.analysisSource).toBe('auto-rule-based');
    expect(await readCached(other._id)).toBeUndefined();
  });

  it('is a no-op for an id that is not an ObjectId', async () => {
    await seedQuest();
    await expect(cacheTelemetryAnalysisOnQuest('not-an-id', cached)).resolves.toBeNull();
  });
});
