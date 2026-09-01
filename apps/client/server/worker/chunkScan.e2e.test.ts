import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';
import {
  buildStrandedVectorizeScanFilter,
  CHUNK_CLAIM_STALE_MS,
  VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS,
} from './chunkScan';

/**
 * Real-Mongo guard for the stranded-vectorize sweep's stale-claim arm, driving THIS builder rather
 * than a copy of its output. packages/database/src/__tests__/fabFileVectorizeStranded.test.ts also
 * covers the shape against a real mongod, but hand-writes the filter literal (it cannot import
 * apps/client), so it cannot notice the arms here changing; chunkScan.test.ts drives the real
 * builder but matches documents in JS, so it cannot notice Mongo disagreeing with that matcher.
 * This file is the one place both halves are real at once.
 */

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
});

const now = Date.now();
const cutoff = new Date(now - VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS);
const staleClaimBefore = new Date(now - CHUNK_CLAIM_STALE_MS);

/** Every seeded file is a genuine stranded-vectorize candidate; only the claim state varies. */
async function seedClaimStates() {
  const stranded = {
    userId: 'u1',
    type: 'FILE',
    chunked: true,
    chunkCount: 7,
    vectorizeEnqueueFailedAt: new Date(now - VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS - 60_000),
  };
  await FabFile.create([
    { ...stranded, fileName: 'free.pdf', isChunking: false },
    { ...stranded, fileName: 'no-claim-field.pdf' },
    {
      ...stranded,
      fileName: 'hardkill-stale.pdf',
      isChunking: true,
      chunkClaimedAt: new Date(now - CHUNK_CLAIM_STALE_MS - 60_000),
    },
    { ...stranded, fileName: 'hardkill-no-stamp.pdf', isChunking: true, chunkClaimedAt: null },
    { ...stranded, fileName: 'live-claim.pdf', isChunking: true, chunkClaimedAt: new Date(now - 60_000) },
  ]);
}

const select = async (filter: ReturnType<typeof buildStrandedVectorizeScanFilter>) =>
  (await FabFile.find(filter).select('fileName').lean()).map(f => f.fileName).sort();

describe('buildStrandedVectorizeScanFilter against a real mongod', () => {
  it('rescues a claim a hard-killed worker left behind, and never a live one', async () => {
    // The failure the arm exists for: resumeVectorizeEnqueue holds isChunking across real work, so
    // an OOM/timeout/deploy kill inside that window never runs the finally that clears it.
    await seedClaimStates();

    expect(await select(buildStrandedVectorizeScanFilter(cutoff, staleClaimBefore))).toEqual([
      'free.pdf',
      'hardkill-no-stamp.pdf',
      'hardkill-stale.pdf',
      'no-claim-field.pdf',
    ]);
  });

  it('without the cutoff selects only unclaimed files - the gap this arm closes', async () => {
    await seedClaimStates();

    expect(await select(buildStrandedVectorizeScanFilter(cutoff))).toEqual(['free.pdf', 'no-claim-field.pdf']);
  });

  it('keeps the partial vectorizeEnqueueFailedAt index leading the plan', async () => {
    // A three-way $or is exactly the shape that can tip the planner into subplanning and a
    // collection scan across every FabFile - see the comment on the residual $or in chunkScan.ts.
    // The decoy population is load-bearing: on a handful of documents every index costs the same
    // and the planner picks arbitrarily, so an explain assertion over a bare 5-doc collection
    // proves nothing. These 2000 unstamped files are outside the partial index entirely, which is
    // what makes choosing it the only cheap plan.
    await seedClaimStates();
    await FabFile.createIndexes();
    await FabFile.collection.insertMany(
      Array.from({ length: 2000 }, (_, i) => ({
        userId: 'u1',
        fileName: `decoy-${i}.pdf`,
        type: 'FILE',
        chunked: true,
        deletedAt: null,
        vectorizeEnqueueFailedAt: null,
      }))
    );

    const plan = await FabFile.collection
      .find(buildStrandedVectorizeScanFilter(cutoff, staleClaimBefore) as never)
      .explain('queryPlanner');

    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain('"indexName":"vectorizeEnqueueFailedAt_1"');
    expect(winning).not.toContain('"stage":"COLLSCAN"');
  });

  it('still excludes a deleted or un-chunked file when the arm is on', async () => {
    // The arm widens the claim predicate only; it must not open a door for files that are some
    // other sweep's business.
    const stranded = {
      userId: 'u1',
      type: 'FILE',
      isChunking: true,
      chunkClaimedAt: new Date(now - CHUNK_CLAIM_STALE_MS - 60_000),
      vectorizeEnqueueFailedAt: new Date(now - VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS - 60_000),
    };
    await FabFile.create([
      { ...stranded, fileName: 'unchunked.pdf', chunked: false },
      { ...stranded, fileName: 'deleted.pdf', chunked: true, deletedAt: new Date() },
      { ...stranded, fileName: 'keeper.pdf', chunked: true },
    ]);

    expect(await select(buildStrandedVectorizeScanFilter(cutoff, staleClaimBefore))).toEqual(['keeper.pdf']);
  });
});
