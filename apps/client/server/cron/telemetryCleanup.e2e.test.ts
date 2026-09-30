import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { Context } from 'aws-lambda';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest } from '@bike4mind/database';
import { handler } from './telemetryCleanup';

/**
 * Retention sweep against a real mongod: softDeletePlugin's find and update hooks hide tombstones
 * by default, but a soft-deleted quest's telemetry is subject to the same 90-day limit.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  connectDB: vi.fn(),
}));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('telemetryCleanup handler', () => {
  it('strips expired telemetry from live and soft-deleted quests, and keeps fresh telemetry', async () => {
    const telemetry = { anonymousSessionId: { hash: 'h' } };
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const { insertedIds } = await Quest.collection.insertMany([
      { timestamp: old, promptMeta: { contextTelemetry: telemetry }, deletedAt: null },
      { timestamp: old, promptMeta: { contextTelemetry: telemetry }, deletedAt: new Date() },
      { timestamp: new Date(), promptMeta: { contextTelemetry: telemetry }, deletedAt: new Date() },
    ]);

    await handler(undefined as never, { awsRequestId: 'req-1' } as Context);

    const [expiredLive, expiredTombstone, freshTombstone] = await Promise.all(
      Object.values(insertedIds).map(_id => Quest.collection.findOne({ _id }))
    );
    expect(expiredLive?.promptMeta?.contextTelemetry).toBeUndefined();
    expect(expiredTombstone?.promptMeta?.contextTelemetry).toBeUndefined();
    expect(freshTombstone?.promptMeta?.contextTelemetry).toEqual(telemetry);
  });
});
