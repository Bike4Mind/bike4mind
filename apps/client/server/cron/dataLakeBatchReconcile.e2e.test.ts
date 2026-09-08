import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { dataLakeBatchRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

/**
 * Real-Mongo guard for runStuckBatchSweep: both the hosted daily cron (handler(), in
 * dataLakeBatchReconcile.test.ts, fully mocked) and the self-host worker's new scheduled task
 * (worker/main.ts) call this function directly, so proving it actually persists the
 * forced-terminal transition against a real batch document - not a mocked reconciler - is what
 * backs self-host's new dependency on it. Lives in apps/client because it is the only package
 * with both @bike4mind/services and @bike4mind/database as dependencies. Consumes the built
 * dist, so `pnpm turbo:core:build` must be current.
 */

const h = vi.hoisted(() => ({
  recordForced: vi.fn(),
  recordGauge: vi.fn(),
}));
vi.mock('@server/utils/cloudwatch', () => ({
  recordReconcilerForcedTerminal: (...a: unknown[]) => h.recordForced(...a),
  recordStuckBatchGauge: (...a: unknown[]) => h.recordGauge(...a),
}));

import { runStuckBatchSweep } from './dataLakeBatchReconcile';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
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
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof runStuckBatchSweep>[0];

const TIMEOUT_MS = dataLakeService.DEFAULT_STUCK_BATCH_TIMEOUT_MS;

// timestamps:true auto-stamps updatedAt to now on create, so backdate it directly
// (timestamps:false) to seed a genuinely-stale doc - mirrors DataLakeModel.test.ts's seedBatch.
async function seedBatch(status: string, ageMs: number) {
  const batch = await dataLakeBatchRepository.create({
    dataLakeId: 'lake1',
    userId: 'u1',
    status,
    totalFiles: 1,
  } as never);
  await mongoose.models.DataLakeBatch.updateOne(
    { _id: batch.id },
    { $set: { updatedAt: new Date(Date.now() - ageMs) } },
    { timestamps: false }
  );
  return batch;
}

describe('runStuckBatchSweep - real repos + real Mongo (hosted + self-host shared entrypoint)', () => {
  it('forces a genuinely-stuck batch terminal in the real DB and reports it', async () => {
    const stuck = await seedBatch('processing', TIMEOUT_MS + 60_000);

    const result = await runStuckBatchSweep(logger);

    expect(result.candidates).toBe(1);
    expect(result.forced).toEqual([stuck.id]);
    const after = await dataLakeBatchRepository.findById(stuck.id);
    expect(after?.status).toBe('completed_with_errors');
    expect(h.recordGauge).toHaveBeenCalledWith(1);
    expect(h.recordForced).toHaveBeenCalledTimes(1);
  });

  it('leaves a batch under the timeout untouched', async () => {
    const fresh = await seedBatch('processing', TIMEOUT_MS - 60_000);

    const result = await runStuckBatchSweep(logger);

    expect(result.candidates).toBe(0);
    expect(result.forced).toEqual([]);
    const after = await dataLakeBatchRepository.findById(fresh.id);
    expect(after?.status).toBe('processing');
    expect(h.recordForced).not.toHaveBeenCalled();
  });

  it('a zero-candidate run reports cleanly with no side effects', async () => {
    const result = await runStuckBatchSweep(logger);
    expect(result).toEqual({ candidates: 0, forced: [] });
    expect(h.recordForced).not.toHaveBeenCalled();
    expect(h.recordGauge).toHaveBeenCalledWith(0);
  });
});
