import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260915120000_delete-near-empty-vectorized-fabfilechunks';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function raw(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection(name);
}

async function insertFabFile(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    userId: 'user-1',
    fileName: 'contract.pdf',
    deletedAt: null,
    chunkCount: 0,
    chunkedCharCount: 0,
    maxChunkCharLength: 0,
    vectorizedChunkCount: 0,
    embeddedChunkCount: 0,
    embeddedCharCount: 0,
    ...overrides,
  };
  await raw('fabfiles').insertOne(doc);
  return doc;
}

// overrides.vector === null OMITS the field entirely (so the scan's `'vector.0': {$exists: true}`
// correctly excludes it, which a stored `null` would also fail); omitting `vector` altogether
// defaults to a real vector, matching most call sites' "already embedded" intent.
async function insertChunk(
  fabFileId: string,
  overrides: { text?: string; charLength?: number; vector?: number[] | null } = {}
) {
  const text = overrides.text ?? 'x';
  const charLength = overrides.charLength ?? text.length;
  const doc: Record<string, unknown> = {
    _id: new mongoose.Types.ObjectId(),
    fabFileId,
    text,
    tokenCount: 1,
    charLength,
  };
  if (overrides.vector !== null) doc.vector = overrides.vector ?? [0.1];
  await raw('fabfilechunks').insertOne(doc);
  return doc;
}

/** Bulk variant of insertChunk, via insertMany - for a large `count` this avoids `count` round
 *  trips against mongodb-memory-server inside a hook-timeout-bounded suite. */
async function insertChunks(
  fabFileId: string,
  count: number,
  overrides: { text?: string; charLength?: number; vector?: number[] | null } = {}
) {
  const text = overrides.text ?? 'x';
  const charLength = overrides.charLength ?? text.length;
  const docs = Array.from({ length: count }, () => {
    const doc: Record<string, unknown> = {
      _id: new mongoose.Types.ObjectId(),
      fabFileId,
      text,
      tokenCount: 1,
      charLength,
    };
    if (overrides.vector !== null) doc.vector = overrides.vector ?? [0.1];
    return doc;
  });
  await raw('fabfilechunks').insertMany(docs);
  return docs;
}

const chunkIds = async () =>
  (
    await raw('fabfilechunks')
      .find({}, { projection: { _id: 1 } })
      .toArray()
  ).map(d => String(d._id));

const fabFile = async (id: mongoose.Types.ObjectId) => raw('fabfiles').findOne({ _id: id });

describe('delete-near-empty-vectorized-fabfilechunks migration (real DB)', () => {
  it('deletes a vector-bearing chunk under the floor and decrements the rollup', async () => {
    const file = await insertFabFile({
      chunkCount: 2,
      chunkedCharCount: 101,
      maxChunkCharLength: 100,
      vectorizedChunkCount: 2,
      embeddedChunkCount: 2,
      embeddedCharCount: 101,
    });
    const degenerate = await insertChunk(String(file._id), { text: '.', charLength: 1 });
    const healthy = await insertChunk(String(file._id), { text: 'a'.repeat(100), charLength: 100 });

    await migration.up();

    const survivingIds = await chunkIds();
    expect(survivingIds).toEqual([String(healthy._id)]);
    expect(survivingIds).not.toContain(String(degenerate._id));
    const updated = await fabFile(file._id);
    expect(updated).toMatchObject({
      chunkCount: 1,
      chunkedCharCount: 100,
      maxChunkCharLength: 100,
      vectorizedChunkCount: 1,
      embeddedChunkCount: 1,
      embeddedCharCount: 100,
    });
  });

  it('leaves a near-empty chunk with no vector alone', async () => {
    const file = await insertFabFile();
    const vectorless = await insertChunk(String(file._id), { text: '.', charLength: 1, vector: null });

    await migration.up();

    expect(await chunkIds()).toEqual([String(vectorless._id)]);
  });

  it('leaves a vector-bearing chunk with no charLength alone (out of scope until the backfill runs)', async () => {
    // `charLength: { $ne: null, $lt: FLOOR }` excludes a row with the field entirely absent -
    // deliberate: "under the floor" is meaningless without the field it is measured against, and
    // that population belongs to the charLength backfill, not this sweep.
    const file = await insertFabFile();
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      fabFileId: String(file._id),
      text: '.',
      tokenCount: 1,
      vector: [0.1],
    };
    await raw('fabfilechunks').insertOne(doc);

    await migration.up();

    expect(await chunkIds()).toEqual([String(doc._id)]);
  });

  it('leaves a vector-bearing chunk at or above the floor alone', async () => {
    const file = await insertFabFile();
    const okChunk = await insertChunk(String(file._id), { text: 'a'.repeat(50), charLength: 50 });

    await migration.up();

    expect(await chunkIds()).toEqual([String(okChunk._id)]);
  });

  it('keeps the least-degenerate chunk when every chunk in a file is a candidate', async () => {
    const file = await insertFabFile({
      chunkCount: 2,
      vectorizedChunkCount: 2,
      embeddedChunkCount: 2,
      chunkedCharCount: 11,
      embeddedCharCount: 11,
      maxChunkCharLength: 10,
    });
    const shortest = await insertChunk(String(file._id), { text: '.', charLength: 1 });
    const leastDegenerate = await insertChunk(String(file._id), { text: 'a'.repeat(10), charLength: 10 });

    await migration.up();

    // The least-degenerate candidate survives - the file never drops to chunkCount 0.
    const survivingIds = await chunkIds();
    expect(survivingIds).toEqual([String(leastDegenerate._id)]);
    expect(survivingIds).not.toContain(String(shortest._id));
    const updated = await fabFile(file._id);
    expect(updated).toMatchObject({ chunkCount: 1, vectorizedChunkCount: 1 });
  });

  it('recomputes maxChunkCharLength from source rather than assuming it is unaffected', async () => {
    const file = await insertFabFile({
      chunkCount: 2,
      maxChunkCharLength: 100, // stale: as if the deleted chunk once held the recorded max
      vectorizedChunkCount: 2,
      embeddedChunkCount: 2,
      chunkedCharCount: 149,
      embeddedCharCount: 149,
    });
    await insertChunk(String(file._id), { text: '.', charLength: 1 });
    const survivor = await insertChunk(String(file._id), { text: 'a'.repeat(48), charLength: 48 });

    await migration.up();

    const updated = await fabFile(file._id);
    expect(updated).toMatchObject({ maxChunkCharLength: 48 });
    expect(await chunkIds()).toEqual([String(survivor._id)]);
  });

  it('is idempotent - a second run deletes and decrements nothing further', async () => {
    const file = await insertFabFile({
      chunkCount: 2,
      vectorizedChunkCount: 2,
      embeddedChunkCount: 2,
      chunkedCharCount: 101,
      embeddedCharCount: 101,
      maxChunkCharLength: 100,
    });
    await insertChunk(String(file._id), { text: '.', charLength: 1 });
    const healthy = await insertChunk(String(file._id), { text: 'a'.repeat(100), charLength: 100 });

    await migration.up();
    await migration.up();

    expect(await chunkIds()).toEqual([String(healthy._id)]);
    const updated = await fabFile(file._id);
    expect(updated).toMatchObject({ chunkCount: 1, vectorizedChunkCount: 1 });
  });

  it('pages past the page size when deleting', async () => {
    const file = await insertFabFile();
    // A healthy chunk alongside 600 candidates so the sole-survivor guard never engages -
    // this test is purely about paging past DELETE_BATCH_SIZE/PAGE_SIZE, not the guard.
    const healthy = await insertChunk(String(file._id), { text: 'a'.repeat(50), charLength: 50 });
    await insertChunks(String(file._id), 600, { text: '.', charLength: 1 });

    await migration.up();

    expect(await chunkIds()).toEqual([String(healthy._id)]);
  });

  it('reports the scanned and deleted counts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = await insertFabFile({
      chunkCount: 2,
      vectorizedChunkCount: 2,
      embeddedChunkCount: 2,
      chunkedCharCount: 101,
      embeddedCharCount: 101,
      maxChunkCharLength: 100,
    });
    await insertChunk(String(file._id), { text: '.', charLength: 1 });
    await insertChunk(String(file._id), { text: 'a'.repeat(100), charLength: 100 });

    await migration.up();

    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('Scanned 1 near-empty vector-bearing row(s) across 1 file(s).');
    expect(logged).toContain('Deleted 1 near-empty vector-bearing fabfilechunk row(s) across 1 file(s).');
  });

  it('warns and caps the kept-as-sole-chunk id list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 60 separate single-chunk files, each entirely degenerate - each keeps its one chunk.
    for (let i = 0; i < 60; i++) {
      const file = await insertFabFile({ chunkCount: 1, vectorizedChunkCount: 1 });
      await insertChunk(String(file._id), { text: '.', charLength: 1 });
    }

    await migration.up();

    expect(await raw('fabfilechunks').countDocuments()).toBe(60);
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toContain('60 file(s) had every chunk under the floor');
    expect(warned).toContain('... and 10 more (capped at 50)');
  });

  it('keeps the least-degenerate of THREE candidates when every chunk in a file is one', async () => {
    const file = await insertFabFile({ chunkCount: 3, vectorizedChunkCount: 3 });
    await insertChunk(String(file._id), { text: '.', charLength: 1 });
    await insertChunk(String(file._id), { text: '..', charLength: 2 });
    const leastDegenerate = await insertChunk(String(file._id), { text: 'a'.repeat(20), charLength: 20 });

    await migration.up();

    expect(await chunkIds()).toEqual([String(leastDegenerate._id)]);
    const updated = await fabFile(file._id);
    expect(updated).toMatchObject({ chunkCount: 1, vectorizedChunkCount: 1, maxChunkCharLength: 20 });
  });

  it('deletes chunks but leaves the rollup untouched when a rollup field is explicitly null', async () => {
    // resetChunkStateByIds writes exactly this shape mid-reset. $inc-ing a null field throws in
    // real Mongo; this must not throw, and must not "fix" the null into a number either - it stays
    // "unmeasured" until whatever normally measures it (backfill / rebuild / vectorize) does.
    const file = await insertFabFile({
      chunkCount: 2,
      chunkedCharCount: null,
      maxChunkCharLength: null,
      vectorizedChunkCount: 2,
      embeddedChunkCount: null,
      embeddedCharCount: null,
    });
    await insertChunk(String(file._id), { text: '.', charLength: 1 });
    const healthy = await insertChunk(String(file._id), { text: 'a'.repeat(100), charLength: 100 });

    await expect(migration.up()).resolves.not.toThrow();

    expect(await chunkIds()).toEqual([String(healthy._id)]);
    const updated = await fabFile(file._id);
    expect(updated).toMatchObject({
      chunkCount: 2, // unrepaired - left exactly as it was, not decremented, not recomputed
      chunkedCharCount: null,
      maxChunkCharLength: null,
      vectorizedChunkCount: 2,
      embeddedChunkCount: null,
      embeddedCharCount: null,
    });
  });

  it('deletes chunks but leaves the rollup untouched when a rollup field is entirely absent (legacy row)', async () => {
    const file = { _id: new mongoose.Types.ObjectId(), userId: 'user-1', fileName: 'legacy.pdf', deletedAt: null };
    await raw('fabfiles').insertOne(file); // no rollup fields at all, unlike insertFabFile's defaults
    await insertChunk(String(file._id), { text: '.', charLength: 1 });
    const healthy = await insertChunk(String(file._id), { text: 'a'.repeat(100), charLength: 100 });

    await expect(migration.up()).resolves.not.toThrow();

    expect(await chunkIds()).toEqual([String(healthy._id)]);
    const updated = await fabFile(file._id);
    expect(updated?.chunkCount).toBeUndefined();
    expect(updated?.vectorizedChunkCount).toBeUndefined();
  });

  it('deletes chunks for a non-ObjectId fabFileId and warns rather than throwing', async () => {
    // The sibling unaddressable-chunk migration deliberately KEEPS such rows when the value still
    // embeds a resolvable file id - so a near-empty, vector-bearing row with a malformed
    // fabFileId is a real, if rare, shape this migration can encounter.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A second, healthy chunk under the same bogus fabFileId so the sole-survivor guard does not
    // engage and the degenerate row genuinely gets deleted.
    const degenerate = await insertChunk('not-an-object-id', { text: '.', charLength: 1 });
    const healthy = await insertChunk('not-an-object-id', { text: 'a'.repeat(100), charLength: 100 });

    await expect(migration.up()).resolves.not.toThrow();

    expect(await raw('fabfilechunks').countDocuments({ _id: degenerate._id as mongoose.Types.ObjectId })).toBe(0);
    expect(await raw('fabfilechunks').countDocuments({ _id: healthy._id as mongoose.Types.ObjectId })).toBe(1);
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toContain('1 file(s) had a non-ObjectId fabFileId');
  });

  it('repairs multiple touched files independently in one run, with no cross-file contamination', async () => {
    const fileA = await insertFabFile({
      chunkCount: 2,
      chunkedCharCount: 101,
      maxChunkCharLength: 100,
      vectorizedChunkCount: 2,
      embeddedChunkCount: 2,
      embeddedCharCount: 101,
    });
    await insertChunk(String(fileA._id), { text: '.', charLength: 1 });
    const healthyA = await insertChunk(String(fileA._id), { text: 'a'.repeat(100), charLength: 100 });

    const fileB = await insertFabFile({
      chunkCount: 4,
      chunkedCharCount: 89,
      maxChunkCharLength: 60,
      vectorizedChunkCount: 4,
      embeddedChunkCount: 4,
      embeddedCharCount: 89,
    });
    await insertChunk(String(fileB._id), { text: '..', charLength: 2 });
    await insertChunk(String(fileB._id), { text: 'x'.repeat(7), charLength: 7 });
    await insertChunk(String(fileB._id), { text: 'y'.repeat(20), charLength: 20 });
    const healthyB = await insertChunk(String(fileB._id), { text: 'z'.repeat(60), charLength: 60 });

    await migration.up();

    expect((await chunkIds()).sort()).toEqual([String(healthyA._id), String(healthyB._id)].sort());
    expect(await fabFile(fileA._id)).toMatchObject({
      chunkCount: 1,
      chunkedCharCount: 100,
      maxChunkCharLength: 100,
      vectorizedChunkCount: 1,
      embeddedChunkCount: 1,
      embeddedCharCount: 100,
    });
    expect(await fabFile(fileB._id)).toMatchObject({
      chunkCount: 1,
      chunkedCharCount: 60,
      maxChunkCharLength: 60,
      vectorizedChunkCount: 1,
      embeddedChunkCount: 1,
      embeddedCharCount: 60,
    });
  });
});
