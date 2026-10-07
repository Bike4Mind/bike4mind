import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest } from '@bike4mind/database';
import { triggerTelemetryDeletion } from './telemetryDeletion';

/**
 * Opt-out erasure against a real mongod: softDeletePlugin's update hook skips tombstones by
 * default, and a soft-deleted quest still stores its telemetry, so the erasure must reach it too.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('./telemetryHashLookup', () => ({ regenerateUserTelemetryHashes: vi.fn(async () => ['user-hash']) }));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('triggerTelemetryDeletion', () => {
  it('removes telemetry from live and soft-deleted quests alike', async () => {
    const telemetry = { anonymousSessionId: { hash: 'user-hash' } };
    const { insertedIds } = await Quest.collection.insertMany([
      { promptMeta: { contextTelemetry: telemetry }, deletedAt: null },
      { promptMeta: { contextTelemetry: telemetry }, deletedAt: new Date() },
      { promptMeta: { contextTelemetry: { anonymousSessionId: { hash: 'other-hash' } } }, deletedAt: null },
    ]);

    await triggerTelemetryDeletion('user-1', { headers: {} });

    const [live, tombstone, other] = await Promise.all(
      Object.values(insertedIds).map(_id => Quest.collection.findOne({ _id }))
    );
    expect(live?.promptMeta?.contextTelemetry).toBeUndefined();
    expect(tombstone?.promptMeta?.contextTelemetry).toBeUndefined();
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
    expect(other?.promptMeta?.contextTelemetry).toEqual({ anonymousSessionId: { hash: 'other-hash' } });
  });
});
