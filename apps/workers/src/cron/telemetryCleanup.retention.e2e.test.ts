import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Quest } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { runTelemetryCleanup } from './telemetryCleanup';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const now = new Date('2026-04-01T03:00:00Z');
const cutoff = new Date(now.getTime() - 90 * 86_400_000);
async function seed(timestamp: Date, telemetry = true) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    timestamp,
    userId: 'local-owner',
    text: 'keep conversation',
    promptMeta: { finishReason: 'stop', ...(telemetry ? { contextTelemetry: { marker: 'expired' } } : {}) },
  };
  await Quest.collection.insertOne(doc);
  return doc;
}
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Quest.collection.deleteMany({});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('telemetry retention persisted effects', () => {
  it('removes only expired telemetry, preserves the exact boundary and content, and repeats as a no-op', async () => {
    const old = await seed(new Date(cutoff.getTime() - 1));
    const exact = await seed(cutoff);
    const recent = await seed(new Date(cutoff.getTime() + 1));
    const absent = await seed(new Date(cutoff.getTime() - 1), false);
    expect(await runTelemetryCleanup()).toEqual({ modifiedCount: 1, batches: 1, cutoff: cutoff.toISOString() });
    const expected = { ...old, promptMeta: { finishReason: 'stop' }, updatedAt: now };
    expect(await Quest.collection.findOne({ _id: old._id })).toEqual(expected);
    for (const row of [exact, recent, absent]) expect(await Quest.collection.findOne({ _id: row._id })).toEqual(row);
    expect(await runTelemetryCleanup()).toEqual({ modifiedCount: 0, batches: 0, cutoff: cutoff.toISOString() });
  });
  it('keeps successful batches after a later write failure and retries the remaining rows', async () => {
    for (let i = 0; i < 5; i++) await seed(new Date(cutoff.getTime() - 1));
    const original = Quest.updateMany.bind(Quest);
    const write = vi.spyOn(Quest, 'updateMany');
    write
      .mockImplementationOnce((...args) => original(...args))
      .mockImplementationOnce(() => {
        throw new Error('injected write failure');
      });
    await expect(runTelemetryCleanup({ batchSize: 2 })).rejects.toThrow('injected write failure');
    expect(await Quest.collection.countDocuments({ 'promptMeta.contextTelemetry': { $exists: true } })).toBe(3);
    write.mockRestore();
    expect(await runTelemetryCleanup({ batchSize: 2 })).toEqual({
      modifiedCount: 3,
      batches: 2,
      cutoff: cutoff.toISOString(),
    });
    expect(await Quest.collection.countDocuments({ 'promptMeta.contextTelemetry': { $exists: true } })).toBe(0);
    expect(
      await Quest.collection.countDocuments({ text: 'keep conversation', 'promptMeta.finishReason': 'stop' })
    ).toBe(5);
  });
  it('keeps one cutoff even when the clock crosses a day between batches', async () => {
    await seed(new Date(cutoff.getTime() - 1));
    const recent = await seed(new Date(cutoff.getTime() + 1));
    const original = Quest.updateMany.bind(Quest);
    vi.spyOn(Quest, 'updateMany').mockImplementationOnce((...args) => {
      const query = original(...args);
      vi.setSystemTime(new Date(now.getTime() + 86_400_000));
      return query;
    });
    expect(await runTelemetryCleanup({ batchSize: 1 })).toEqual({
      modifiedCount: 1,
      batches: 1,
      cutoff: cutoff.toISOString(),
    });
    expect(await Quest.collection.findOne({ _id: recent._id })).toEqual(recent);
  });
});
