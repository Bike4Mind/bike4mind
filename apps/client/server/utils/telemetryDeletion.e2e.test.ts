import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest, TelemetryAuditLogModel } from '@bike4mind/database';
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([Quest.collection.deleteMany({}), TelemetryAuditLogModel.collection.deleteMany({})]);
});

const latestAuditRow = () => TelemetryAuditLogModel.findOne({ userId: 'user-1' }).sort({ createdAt: -1 }).lean();

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

  it('verifies the deletion by re-counting, tombstones included, and audits the result', async () => {
    const telemetry = { anonymousSessionId: { hash: 'user-hash' } };
    await Quest.collection.insertMany([
      { promptMeta: { contextTelemetry: telemetry }, deletedAt: null },
      { promptMeta: { contextTelemetry: telemetry }, deletedAt: new Date() },
    ]);

    const result = await triggerTelemetryDeletion('user-1', { headers: {} });

    expect(result).toEqual({ verified: true, deletedCount: 2, remainingCount: 0 });
    const audit = await latestAuditRow();
    expect(audit?.outcome).toBe('success');
    expect(audit?.metadata).toMatchObject({ deletedCount: 2, verified: true, remainingCount: 0 });
  });

  it('reports what is left when the unset misses documents, and a repeat run clears them', async () => {
    const telemetry = { anonymousSessionId: { hash: 'user-hash' } };
    await Quest.collection.insertMany([
      { promptMeta: { contextTelemetry: telemetry }, deletedAt: null },
      { promptMeta: { contextTelemetry: telemetry }, deletedAt: new Date() },
    ]);
    // An unset that touches nothing, so the re-check runs against documents that still carry telemetry.
    const noOpUpdate = { setOptions: () => Promise.resolve({ modifiedCount: 0 }) };
    vi.spyOn(Quest, 'updateMany').mockReturnValueOnce(noOpUpdate as unknown as ReturnType<typeof Quest.updateMany>);

    const first = await triggerTelemetryDeletion('user-1', { headers: {} });

    expect(first).toEqual({ verified: false, deletedCount: 0, remainingCount: 2 });
    const failed = await latestAuditRow();
    expect(failed?.outcome).toBe('failure');
    expect(failed?.metadata).toMatchObject({ verified: false, remainingCount: 2 });

    const second = await triggerTelemetryDeletion('user-1', { headers: {} });

    expect(second).toEqual({ verified: true, deletedCount: 2, remainingCount: 0 });
  });
});
