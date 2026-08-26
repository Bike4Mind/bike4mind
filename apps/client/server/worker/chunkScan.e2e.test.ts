import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { CONVERGENCE_PAUSED_CHUNK_NOTE, CONVERGENCE_PAUSED_NOTE } from '@bike4mind/common';
import { buildFabFileChunkScanFilter, NO_EXTRACTABLE_TEXT_NOTE_PREFIX } from './chunkScan';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Agreement test for the chunk rescue sweep's selection filter.
 *
 * The unit tests assert the filter's behaviour through a hand-rolled evaluator for the subset of
 * Mongo operators it uses. That evaluator is a model of Mongo, not Mongo - and this filter now leans
 * on two operator semantics that are easy to model wrongly and expensive to get wrong:
 *
 *  - `$nin` MATCHES a missing or null field. Model that as "excluded" and the sweep silently stops
 *    selecting every un-noted file, which is a far worse failure than the churn the exclusion fixes.
 *  - `$not` and `$nin` in the SAME field expression must both apply. A first-match-wins model passes
 *    while the real query enforces only one of them.
 *
 * So this runs the actual filter against a real server. It asserts selection only - no writes, no
 * handler - which is what keeps it cheap enough to be worth having.
 */
let mongoServer: MongoMemoryServer;
let fabFiles: mongoose.Collection;

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

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  fabFiles = mongoose.connection.collection('chunkscanfabfiles');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await fabFiles.deleteMany({});
});

describe('buildFabFileChunkScanFilter against real Mongo', () => {
  it('selects an ordinary un-chunked file and leaves the terminal and in-flight ones alone', async () => {
    await fabFiles.insertMany([
      candidate({ name: 'plain' }),
      candidate({ name: 'no-text', notes: `${NO_EXTRACTABLE_TEXT_NOTE_PREFIX}: scanned image` }),
      candidate({ name: 'errored', error: 'chunker exploded' }),
      candidate({ name: 'in-flight', isChunking: true }),
      candidate({ name: 'already-chunked', chunkCount: 12 }),
      candidate({ name: 'too-new', createdAt: new Date('2026-02-01T00:00:00Z') }),
      candidate({ name: 'an-image', mimeType: 'image/png' }),
    ]);

    expect(await selectedNames(buildFabFileChunkScanFilter(CUTOFF))).toEqual(['plain']);
  });

  it('excludes both pause markers while the kill switch is ON, and nothing else', async () => {
    await fabFiles.insertMany([
      candidate({ name: 'plain' }),
      candidate({ name: 'paused-chunk', notes: CONVERGENCE_PAUSED_CHUNK_NOTE }),
      candidate({ name: 'paused-vectorize', notes: CONVERGENCE_PAUSED_NOTE }),
      candidate({ name: 'user-note', notes: 'quarterly report for the board deck' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
    expect(await selectedNames(filter)).toEqual(['plain', 'user-note']);
  });

  it('KEEPS a null or missing notes field selectable while excluding the markers', async () => {
    // The semantics worth proving on a real server: `$nin` matches a null and a missing field. If it
    // did not, turning the switch on would drop every un-noted file out of the sweep - the exact
    // silent-stall this exclusion exists to avoid, reintroduced from the other side.
    await fabFiles.insertMany([
      candidate({ name: 'notes-null', notes: null }),
      candidate({ name: 'notes-missing' }),
      candidate({ name: 'notes-empty', notes: '' }),
      candidate({ name: 'paused', notes: CONVERGENCE_PAUSED_CHUNK_NOTE }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
    expect(await selectedNames(filter)).toEqual(['notes-empty', 'notes-missing', 'notes-null']);
  });

  it('applies BOTH notes operators at once, not whichever comes first', async () => {
    // `$not` (no-extractable-text) and `$nin` (pause markers) share the `notes` field expression.
    // A query that honoured only one would let one of these two through.
    await fabFiles.insertMany([
      candidate({ name: 'no-text', notes: `${NO_EXTRACTABLE_TEXT_NOTE_PREFIX}: nothing here` }),
      candidate({ name: 'paused', notes: CONVERGENCE_PAUSED_CHUNK_NOTE }),
      candidate({ name: 'keeper' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
    expect(await selectedNames(filter)).toEqual(['keeper']);
  });

  it('sweeps the paused files back in once the kill switch is OFF', async () => {
    // The rebuild path the marker's own wording promises, and the regression an unconditional
    // exclusion would have introduced.
    await fabFiles.insertMany([
      candidate({ name: 'plain' }),
      candidate({ name: 'paused-chunk', notes: CONVERGENCE_PAUSED_CHUNK_NOTE }),
      candidate({ name: 'paused-vectorize', notes: CONVERGENCE_PAUSED_NOTE }),
      candidate({ name: 'no-text', notes: `${NO_EXTRACTABLE_TEXT_NOTE_PREFIX}: scanned image` }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: false });
    // The no-text file stays out - that exclusion is terminal regardless of the switch.
    expect(await selectedNames(filter)).toEqual(['paused-chunk', 'paused-vectorize', 'plain']);
  });

  it('sweeps a stamped media file back in via the stale-claim arm, unchanged by this exclusion', async () => {
    // Guards the interaction: the media clause's stamped-file exception and the notes exclusion sit
    // under different keys, and a malformed combination could silently drop either.
    await fabFiles.insertMany([
      candidate({ name: 'stamped-image', mimeType: 'image/png', chunkRebuildRequestedAt: OLD }),
      candidate({ name: 'plain-image', mimeType: 'image/png' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
    expect(await selectedNames(filter)).toEqual(['stamped-image']);
  });
});
