import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';
import { VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS } from './chunkScan';

/**
 * Real-Mongo guard for runStrandedVectorizeRescue.
 *
 * chunkRescueSweep.test.ts stubs both FabFile.find and buildStrandedVectorizeScanFilter, so it
 * pins the enqueue accounting but says nothing about which documents the pass actually selects;
 * chunkScan.test.ts asserts the filter against a hand-rolled operator evaluator, not a mongod.
 * Neither would catch a filter that is wrong only against real Mongo semantics - the missing-field
 * -vs-null equivalence behind `deletedAt: null` and `isChunking: {$ne: true}`, or the `$type:'date'`
 * bracketing on the stamp. Self-host has no other door to these files, so this runs the exported
 * pass end-to-end over a seeded collection instead. Mirrors dataLakeBatchReconcile.e2e.test.ts.
 */

const h = vi.hoisted(() => ({ sendToQueue: vi.fn() }));
vi.mock('sst', () => ({ Resource: { fabFileChunkQueue: { url: 'http://elasticmq/fabFileChunkQueue' } } }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));

import { runStrandedVectorizeRescue } from './chunkRescueSweep';

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

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<
  typeof runStrandedVectorizeRescue
>[0];

/** Comfortably past the grace period, so the stamp is never the reason a fixture is skipped. */
const STRANDED_AT = new Date(Date.now() - VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS - 60_000);

const userId = new mongoose.Types.ObjectId();

async function seed(overrides: Record<string, unknown>) {
  return FabFile.create({
    userId,
    name: 'f',
    fileName: 'f.txt',
    type: KnowledgeType.FILE,
    vectorizeEnqueueFailedAt: STRANDED_AT,
    chunked: true,
    deletedAt: null,
    ...overrides,
  });
}

/** fabFileIds the pass enqueued, in send order. */
const sentIds = () => h.sendToQueue.mock.calls.map(([, msg]) => (msg as { fabFileId: string }).fabFileId);

describe('runStrandedVectorizeRescue against real Mongo', () => {
  it('selects exactly the stranded files and leaves every near-miss alone', async () => {
    const stranded = await seed({ name: 'stranded' });
    // Each of these differs from `stranded` in ONE field, so a fixture that starts being swept
    // names the clause that broke rather than just failing a count.
    await seed({ name: 'too-fresh', vectorizeEnqueueFailedAt: new Date() });
    // chunkClaimedAt recent (not stale, not the null backfill arm), so this stays a genuine
    // in-flight near-miss under the stale-claim rescue arm too.
    await seed({ name: 'in-flight', isChunking: true, chunkClaimedAt: new Date() });
    await seed({ name: 'un-chunked', chunked: false });
    // Held out by softDeletePlugin's pre('find') hook (db-core utils/mongo.ts), which injects
    // `deletedAt: null` into every find that did not opt into `includeDeleted` - NOT by the
    // filter's own `deletedAt` clause, which is redundant at runtime and covered instead by
    // chunkScan.test.ts. Here to pin the end-to-end outcome: a soft-deleted file is never
    // re-enqueued, whichever of the two guards is doing the work.
    await seed({ name: 'deleted', deletedAt: new Date() });
    // No stamp at all: the field is absent, not null. `$lt` is type-bracketed, so this must not
    // match - the whole collection would otherwise be in scope once a minute, forever.
    await seed({ name: 'never-failed', vectorizeEnqueueFailedAt: undefined });

    await expect(runStrandedVectorizeRescue(logger)).resolves.toBe(1);

    expect(sentIds()).toEqual([String(stranded._id)]);
  });

  it('stamps convergence provenance only on files that belong to a batch', async () => {
    const lone = await seed({ name: 'lone' });
    const batched = await seed({ name: 'batched', batchId: 'batch-1' });

    await expect(runStrandedVectorizeRescue(logger)).resolves.toBe(2);

    // Batch files are convergence work the kill switch may halt; a lone rescue is not, and
    // stamping it would make the switch stop it too. batchId survives the .select() projection.
    expect(h.sendToQueue).toHaveBeenCalledWith('http://elasticmq/fabFileChunkQueue', {
      fabFileId: String(batched._id),
      userId: String(userId),
      origin: 'convergence',
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('http://elasticmq/fabFileChunkQueue', {
      fabFileId: String(lone._id),
      userId: String(userId),
    });
  });

  it('stays quiet when the collection holds nothing to rescue', async () => {
    await seed({ name: 'un-chunked', chunked: false });

    await expect(runStrandedVectorizeRescue(logger)).resolves.toBe(0);

    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
