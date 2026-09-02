import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { CHUNK_STALL_NOTICES } from '@bike4mind/common';
import { buildFabFileChunkScanFilter } from './chunkScan';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
      candidate({ name: 'no-text', noExtractableTextAt: OLD }),
      candidate({ name: 'errored', error: 'chunker exploded' }),
      candidate({ name: 'in-flight', isChunking: true }),
      candidate({ name: 'already-chunked', chunkCount: 12 }),
      candidate({ name: 'too-new', createdAt: new Date('2026-02-01T00:00:00Z') }),
      candidate({ name: 'an-image', mimeType: 'image/png' }),
    ]);

    expect(
      await selectedNames(buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: false }))
    ).toEqual(['plain']);
  });

  it('excludes both stall reasons while the kill switch is ON, and nothing else', async () => {
    await fabFiles.insertMany([
      candidate({ name: 'plain' }),
      candidate({ name: 'paused-chunk', chunkStallReason: 'rechunkPaused' }),
      candidate({ name: 'paused-vectorize', chunkStallReason: 'vectorizePaused' }),
      candidate({ name: 'user-note', notes: 'quarterly report for the board deck' }),
    ]);

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
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

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
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

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
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

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
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

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: false });
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

    const filter = buildFabFileChunkScanFilter(CUTOFF, undefined, { excludeConvergencePaused: true });
    expect(await selectedNames(filter)).toEqual(['stamped-image']);
  });
});
