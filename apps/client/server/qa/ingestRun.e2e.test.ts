import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// Not exported from the package dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { QaRun, QaTestResult } from '@bike4mind/database';
import { ingestRun } from './ingestRun';
import { failedTest, makeIngest, passedTest, TEST_A, TEST_B } from './testFixtures';

// Boots a real mongod, so the file runs on the shared real-Mongo budget (see MONGO_TEST_TIMEOUT_MS).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await Promise.all([QaRun.syncIndexes(), QaTestResult.syncIndexes()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
afterEach(async () => {
  await Promise.all([QaRun.deleteMany({}), QaTestResult.deleteMany({})]);
});

describe('ingestRun', () => {
  it('creates the run with a server-derived status and its tests', async () => {
    const res = await ingestRun(
      makeIngest({
        counts: { passed: 1, failed: 1, skipped: 0, notStarted: 0, ran: 2, total: 2 },
        tests: [passedTest(TEST_A), failedTest(TEST_B)],
      })
    );
    expect(res).toMatchObject({ status: 'failed', created: true });
    expect(await QaTestResult.countDocuments({ runId: res.runId })).toBe(2);
    const run = await QaRun.findById(res.runId).lean();
    expect(run?.tenant).toBeUndefined();
    expect(run?.startedAt.toISOString()).toBe('2026-09-28T09:00:00.000Z');
  });

  it('is idempotent on externalRunId: same run, tests replaced, created=false', async () => {
    const first = await ingestRun(makeIngest());
    const second = await ingestRun(makeIngest({ tests: [passedTest(TEST_A)] }));
    expect(second.runId).toBe(first.runId);
    expect(second.created).toBe(false);
    expect(await QaRun.countDocuments({})).toBe(1);
    expect(await QaTestResult.countDocuments({ runId: first.runId })).toBe(1);
  });

  it('keeps one row per test when the same run is ingested concurrently', async () => {
    // Several rounds: one interleaving of the two delete/insert pairs is enough to double rows.
    for (let i = 0; i < 5; i++) {
      const input = makeIngest({ externalRunId: `${200 + i}-1` });
      const [a, b] = await Promise.all([ingestRun(input), ingestRun(input)]);
      expect(b.runId).toBe(a.runId);
      const keys = (await QaTestResult.find({ runId: a.runId }).lean()).map(r => r.testKey).sort();
      expect(keys).toEqual([TEST_A, TEST_B]);
    }
  });

  it('rethrows an insert failure that is not a duplicate key', async () => {
    const insert = vi
      .spyOn(QaTestResult, 'insertMany')
      .mockRejectedValueOnce(Object.assign(new Error('write failed'), { code: 121 }));
    await expect(ingestRun(makeIngest())).rejects.toThrow('write failed');
    insert.mockRestore();
  });

  it('derives infra-error when nothing ran', async () => {
    const res = await ingestRun(
      makeIngest({ counts: { passed: 0, failed: 1, skipped: 0, notStarted: 40, ran: 0, total: 1 }, tests: [] })
    );
    expect(res.status).toBe('infra-error');
  });

  it('rejects artifact keys outside the run prefix with a 422', async () => {
    const bad = failedTest(TEST_B, {
      artifacts: [{ kind: 'screenshot', key: 'product-a/999-1/media/x.png', bytes: 1 }],
    });
    await expect(ingestRun(makeIngest({ tests: [bad] }))).rejects.toThrow(
      expect.objectContaining({ statusCode: 422, message: expect.stringMatching(/outside this run/) })
    );
    expect(await QaRun.countDocuments({})).toBe(0);
  });

  it('rejects a reportPrefix for another run', async () => {
    await expect(ingestRun(makeIngest({ reportPrefix: 'product-b/100-1/report/' }))).rejects.toThrow(/report_prefix/);
  });
});
