import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';
import { CHUNK_STALL_NOTICES, CHUNK_STALL_REASONS, LEGACY_CHUNK_STALL_NOTES } from '@bike4mind/common';
import { buildDataLakeMembershipFilter } from '@bike4mind/database';
import {
  buildFabFileChunkScanFilter,
  buildStrandedVectorizeScanFilter,
  CHUNK_CLAIM_STALE_MS,
  VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS,
} from './chunkScan';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
let fabFiles: mongoose.Collection;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  fabFiles = mongoose.connection.collection('chunkscanfabfiles');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

// Both suites here own their own collection ('chunkscanfabfiles' below, the FabFile model's own
// for the stranded sweep), so the drop is belt-and-braces isolation rather than shared cleanup -
// it also takes out the indexes the explain test builds.
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

beforeEach(async () => {
  await fabFiles.deleteMany({});
});

/**
 * Real-Mongo guard for the stranded-vectorize sweep's stale-claim arm, driving THIS builder rather
 * than a copy of its output. packages/database/src/__tests__/fabFileVectorizeStranded.test.ts also
 * covers the shape against a real mongod, but hand-writes the filter literal (it cannot import
 * apps/client), so it cannot notice the arms here changing; chunkScan.test.ts drives the real
 * builder but matches documents in JS, so it cannot notice Mongo disagreeing with that matcher.
 * This file is the one place both halves are real at once.
 */
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

/**
 * Agreement test for the chunk rescue sweep's selection filter.
 *
 * The unit tests assert the filter's behaviour through a hand-rolled evaluator for the subset of
 * Mongo operators it uses. That evaluator is a model of Mongo, not Mongo - and this filter leans on
 * two operator semantics that are easy to model wrongly and expensive to get wrong:
 *
 *  - `$nin` MATCHES a missing or null field, and so does an equality against `null`. Model either as
 *    "excluded" and the sweep silently stops selecting every unstalled file, which is a far worse
 *    failure than the churn the exclusion fixes.
 *  - The exclusions sit under several sibling keys (`noExtractableTextAt`, `chunkStallReason`,
 *    `notes`, and two `$or`s nested under one `$and`), and a malformed combination silently drops
 *    one of them.
 *
 * So this runs the actual filter against a real server. It asserts selection only - no writes, no
 * handler - which is what keeps it cheap enough to be worth having.
 */

const CUTOFF = new Date('2026-01-01T00:00:00Z');
const OLD = new Date('2025-12-31T00:00:00Z');

/** A file the sweep SHOULD rescue: completed, un-chunked, old, not in flight, no terminal marker. */
const candidate = (overrides: Record<string, unknown> = {}) => ({
  status: 'complete',
  chunkCount: 0,
  isChunking: false,
  createdAt: OLD,
  deletedAt: null,
  mimeType: 'application/pdf',
  ...overrides,
});

const selectedNames = async (filter: Record<string, unknown>): Promise<string[]> => {
  const docs = await fabFiles.find(filter as never).toArray();
  return docs.map(d => d.name as string).sort();
};

/** No lake carries an override, so the exclusion is the platform value alone. */
const PLATFORM_ON = { platformPaused: true, paused: [], running: [] };
const PLATFORM_OFF = { platformPaused: false, paused: [], running: [] };

/** A real membership predicate, exactly as toChunkScanConvergencePause builds it. */
const membership = (lake: { datalakeTag: string; fileTagPrefix?: string; creatorUserId?: string }) =>
  buildDataLakeMembershipFilter({ kind: 'owned', ...lake });

const LAKE_META = { datalakeTag: 'datalake:alpha' };
const LAKE_PREFIX = { datalakeTag: 'datalake:beta', fileTagPrefix: 'acme:', creatorUserId: 'creator-1' };

describe('buildFabFileChunkScanFilter against real Mongo', () => {
  it('selects an ordinary un-chunked file and leaves the terminal and in-flight ones alone', async () => {
    await fabFiles.insertMany([
      candidate({ name: 'plain' }),
      candidate({ name: 'no-text', noExtractableTextAt: OLD }),
      candidate({ name: 'errored', error: 'chunker exploded' }),
      candidate({ name: 'in-flight', isChunking: true }),
      candidate({ name: 'already-chunked', chunkCount: 12 }),
      candidate({ name: 'too-new', createdAt: new Date('2026-02-01T00:00:00Z') }),
      candidate({ name: 'an-image', mimeType: 'image/png' }),
    ]);

    expect(
      await selectedNames(buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_OFF }))
    ).toEqual(['plain']);
  });

  it('excludes both stall reasons while the kill switch is ON, and nothing else', async () => {
    await fabFiles.insertMany([
      candidate({ name: 'plain' }),
      candidate({ name: 'paused-chunk', chunkStallReason: 'rechunkPaused' }),
      candidate({ name: 'paused-vectorize', chunkStallReason: 'vectorizePaused' }),
      candidate({ name: 'user-note', notes: 'quarterly report for the board deck' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_ON });
    expect(await selectedNames(filter)).toEqual(['plain', 'user-note']);
  });

  it('excludes a pre-migration row carrying the marker as prose in notes', async () => {
    // The transitional arm: #2016's migration and this code do not deploy atomically, so through the
    // window a paused row has no `chunkStallReason` and the legacy prose is all there is to key on.
    await fabFiles.insertMany([
      candidate({ name: 'legacy-paused-chunk', notes: CHUNK_STALL_NOTICES.rechunkPaused }),
      candidate({ name: 'legacy-paused-vectorize', notes: CHUNK_STALL_NOTICES.vectorizePaused }),
      candidate({ name: 'plain' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_ON });
    expect(await selectedNames(filter)).toEqual(['plain']);
  });

  it('KEEPS a null or missing stall field selectable while excluding the markers', async () => {
    // The semantics worth proving on a real server: `$nin` matches a null and a missing field, and so
    // does `noExtractableTextAt: null`. If either did not, turning the switch on would drop every
    // unstalled file out of the sweep - the exact silent stall this exclusion exists to avoid,
    // reintroduced from the other side.
    await fabFiles.insertMany([
      candidate({ name: 'stall-null', chunkStallReason: null, notes: null, noExtractableTextAt: null }),
      candidate({ name: 'stall-missing' }),
      candidate({ name: 'notes-empty', notes: '' }),
      candidate({ name: 'paused', chunkStallReason: 'rechunkPaused' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_ON });
    expect(await selectedNames(filter)).toEqual(['notes-empty', 'stall-missing', 'stall-null']);
  });

  it('applies EVERY exclusion key at once, not whichever comes first', async () => {
    // The zero-chunk stamp, the stall reason and the legacy prose live under three sibling keys. A
    // query that honoured only one of them would let the other two through.
    await fabFiles.insertMany([
      candidate({ name: 'no-text', noExtractableTextAt: OLD }),
      candidate({ name: 'paused', chunkStallReason: 'rechunkPaused' }),
      candidate({ name: 'legacy-paused', notes: CHUNK_STALL_NOTICES.rechunkPaused }),
      candidate({ name: 'keeper' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_ON });
    expect(await selectedNames(filter)).toEqual(['keeper']);
  });

  it('sweeps the paused files back in once the kill switch is OFF', async () => {
    // The rebuild path the marker's own wording promises, and the regression an unconditional
    // exclusion would have introduced.
    await fabFiles.insertMany([
      candidate({ name: 'plain' }),
      candidate({ name: 'paused-chunk', chunkStallReason: 'rechunkPaused' }),
      candidate({ name: 'paused-vectorize', chunkStallReason: 'vectorizePaused' }),
      candidate({ name: 'legacy-paused', notes: CHUNK_STALL_NOTICES.rechunkPaused }),
      candidate({ name: 'no-text', noExtractableTextAt: OLD }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_OFF });
    // The no-text file stays out - that exclusion is terminal regardless of the switch.
    expect(await selectedNames(filter)).toEqual(['legacy-paused', 'paused-chunk', 'paused-vectorize', 'plain']);
  });

  it('sweeps a stamped media file back in via the media arm, unchanged by this exclusion', async () => {
    // Guards the interaction: the media clause's stamped-file exception and the stall exclusions sit
    // under different keys, and a malformed combination could silently drop either.
    await fabFiles.insertMany([
      candidate({ name: 'stamped-image', mimeType: 'image/png', chunkRebuildRequestedAt: OLD }),
      candidate({ name: 'plain-image', mimeType: 'image/png' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_ON });
    expect(await selectedNames(filter)).toEqual(['stamped-image']);
  });
});

describe('buildFabFileChunkScanFilter - scoped pause against real Mongo (#2157)', () => {
  /** A rescue candidate that has stalled, plus whatever membership signals the case needs. */
  const stalled = (name: string, overrides: Record<string, unknown> = {}) =>
    candidate({ name, chunkStallReason: 'rechunkPaused', ...overrides });

  it("platform OFF: excludes only the paused lake's stalled members", async () => {
    await fabFiles.insertMany([
      stalled('in-paused-lake', { tags: [{ name: 'datalake:alpha' }] }),
      stalled('in-other-lake', { tags: [{ name: 'datalake:gamma' }] }),
      stalled('in-no-lake'),
      candidate({ name: 'unstalled-in-paused-lake', tags: [{ name: 'datalake:alpha' }] }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, {
      convergencePause: { platformPaused: false, paused: [membership(LAKE_META)], running: [] },
    });

    // The un-stalled member stays selectable on purpose: the handler is what writes the stall reason,
    // so excluding it here would leave its state invisible.
    expect(await selectedNames(filter)).toEqual(['in-no-lake', 'in-other-lake', 'unstalled-in-paused-lake']);
  });

  it("platform ON: exempts the running lake's stalled members and excludes the rest", async () => {
    await fabFiles.insertMany([
      stalled('in-running-lake', { tags: [{ name: 'datalake:alpha' }] }),
      stalled('in-other-lake', { tags: [{ name: 'datalake:gamma' }] }),
      stalled('in-no-lake'),
      candidate({ name: 'plain' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, {
      convergencePause: { platformPaused: true, paused: [], running: [membership(LAKE_META)] },
    });

    expect(await selectedNames(filter)).toEqual(['in-running-lake', 'plain']);
  });

  it('honours the PREFIX arm of membership, ownership conjunct included', async () => {
    // The arm no hand-rolled evaluator models: an anchored `$regex` on `tags.name` AND a `userId`
    // match against the lake's creator. Getting the conjunct wrong would make this lake's pause reach
    // every file in the install carrying an `acme:` tag.
    await fabFiles.insertMany([
      stalled('creator-prefixed', { userId: 'creator-1', tags: [{ name: 'acme:legal' }] }),
      stalled('stranger-prefixed', { userId: 'someone-else', tags: [{ name: 'acme:legal' }] }),
      stalled('creator-unprefixed', { userId: 'creator-1', tags: [{ name: 'legal' }] }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, {
      convergencePause: { platformPaused: false, paused: [membership(LAKE_PREFIX)], running: [] },
    });

    expect(await selectedNames(filter)).toEqual(['creator-unprefixed', 'stranger-prefixed']);
  });

  it('excludes a PRE-MIGRATION stalled member of a paused lake, via the legacy notes arm', async () => {
    // The lake conjunct has to hold for BOTH stall representations, or the migration window silently
    // re-admits a scoped-paused lake's files.
    await fabFiles.insertMany([
      candidate({
        name: 'legacy-in-paused',
        notes: CHUNK_STALL_NOTICES.rechunkPaused,
        tags: [{ name: 'datalake:alpha' }],
      }),
      candidate({
        name: 'legacy-in-other',
        notes: CHUNK_STALL_NOTICES.rechunkPaused,
        tags: [{ name: 'datalake:gamma' }],
      }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, {
      convergencePause: { platformPaused: false, paused: [membership(LAKE_META)], running: [] },
    });

    expect(await selectedNames(filter)).toEqual(['legacy-in-other']);
  });

  it('the platform-only exclusion still matches the pre-#2157 sibling-key form', async () => {
    // The `$nor` rewrite must be the same query as the `$nin`s it replaced when there is no lake
    // conjunct - including on null and MISSING fields, where the two could plausibly diverge.
    await fabFiles.insertMany([
      candidate({ name: 'reason-null', chunkStallReason: null }),
      candidate({ name: 'reason-missing' }),
      stalled('stalled'),
      candidate({ name: 'legacy', notes: CHUNK_STALL_NOTICES.vectorizePaused }),
    ]);

    const viaNor = buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_ON });
    const viaNin = {
      ...buildFabFileChunkScanFilter(CUTOFF, undefined, { convergencePause: PLATFORM_OFF }),
      chunkStallReason: { $nin: [...CHUNK_STALL_REASONS] },
      notes: { $nin: [...LEGACY_CHUNK_STALL_NOTES] },
    };

    expect(await selectedNames(viaNor)).toEqual(['reason-missing', 'reason-null']);
    expect(await selectedNames(viaNin)).toEqual(await selectedNames(viaNor));
  });
});
