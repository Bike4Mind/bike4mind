import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, FabFileChunk, fabFileRepository, fabFileChunkRepository } from '../models/content/FabFileModel';
import { CONVERGENCE_PAUSED_CHUNK_NOTE } from '@bike4mind/common';
import { setupMongoTest } from '../__test__/utils';

const TAG = 'datalake:rebuild-test';
// Meta-tag-only scope (fileTagPrefix null => buildDataLakeMembershipFilter returns the meta arm),
// so membership is exactly "carries the lake tag" regardless of owner.
const scope = { datalakeTag: TAG, fileTagPrefix: null, creatorUserId: 'owner' };

const makeFile = (over: Partial<Record<string, unknown>> = {}) => ({
  userId: 'owner',
  fileName: 'doc.txt',
  fileSize: 1000,
  mimeType: 'text/plain',
  type: 'FILE',
  // 'complete' = fully uploaded (schema default is 'pending'); a real lake file has finished
  // uploading before it can be chunked or fail a re-chunk.
  status: 'complete',
  chunked: true,
  tags: [{ name: TAG, strength: 1 }],
  ...over,
});

describe('FabFileChunkRepository.findUnderChunkedFabFileIds', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('returns only files with a chunk over the threshold, worst-first', async () => {
    // Insert f-mid FIRST so insertion order (f-mid, f-big) is the OPPOSITE of worst-first
    // (f-big 6000 > f-mid 2000). That makes the $sort load-bearing: without it the aggregation
    // would return f-mid first and this assertion would fail, so it can't silently regress.
    await FabFileChunk.create([
      { fabFileId: 'f-mid', text: 'c', tokenCount: 2000 },
      { fabFileId: 'f-big', text: 'a', tokenCount: 6000 },
      { fabFileId: 'f-big', text: 'b', tokenCount: 400 },
      { fabFileId: 'f-ok', text: 'd', tokenCount: 500 },
      { fabFileId: 'f-ok', text: 'e', tokenCount: 480 },
    ]);

    const ids = await fabFileChunkRepository.findUnderChunkedFabFileIds(['f-big', 'f-mid', 'f-ok'], 1500);

    expect(ids).toEqual(['f-big', 'f-mid']); // worst-first (NOT insertion order), f-ok excluded
  });

  it('never returns a file outside the provided id set', async () => {
    await FabFileChunk.create([
      { fabFileId: 'in', text: 'x', tokenCount: 5000 },
      { fabFileId: 'out', text: 'y', tokenCount: 5000 },
    ]);

    expect(await fabFileChunkRepository.findUnderChunkedFabFileIds(['in'], 1500)).toEqual(['in']);
  });

  it('an empty id list returns nothing (no scan)', async () => {
    await FabFileChunk.create([{ fabFileId: 'anything', text: 'z', tokenCount: 9000 }]);
    expect(await fabFileChunkRepository.findUnderChunkedFabFileIds([], 1500)).toEqual([]);
  });

  it('a file exactly at the threshold is NOT flagged (strictly greater than)', async () => {
    await FabFileChunk.create([{ fabFileId: 'edge', text: 'z', tokenCount: 1500 }]);
    expect(await fabFileChunkRepository.findUnderChunkedFabFileIds(['edge'], 1500)).toEqual([]);
  });
});

describe('FabFileRepository.findChunkedFilesByScope', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('returns chunked lake files, excluding unchunked / deleted / archived / in-flight / non-member', async () => {
    const [member] = await FabFile.create([makeFile({ userId: 'u1' })]);
    await FabFile.create([
      makeFile({ userId: 'u1', chunked: false }),
      makeFile({ userId: 'u2', deletedAt: new Date() }),
      makeFile({ userId: 'u2', archivedAt: new Date() }),
      makeFile({ userId: 'u2', isChunking: true }), // claimed / in-flight -> excluded
      makeFile({ userId: 'u3', tags: [{ name: 'datalake:other', strength: 1 }] }),
    ]);

    const result = await fabFileRepository.findChunkedFilesByScope(scope);
    expect(result).toEqual([{ id: member._id.toString(), userId: 'u1' }]);
  });

  it('matches the prefix arm: a creator-owned file tagged under the lake prefix, not another owner', async () => {
    const prefixScope = { datalakeTag: TAG, fileTagPrefix: 'proj:', creatorUserId: 'owner' };
    const [ownerFile] = await FabFile.create([
      makeFile({ userId: 'owner', tags: [{ name: 'proj:reports', strength: 1 }] }),
    ]);
    await FabFile.create([
      // same prefix tag but a DIFFERENT owner -> the prefix arm's ownership conjunct excludes it
      makeFile({ userId: 'intruder', tags: [{ name: 'proj:reports', strength: 1 }] }),
    ]);

    const result = await fabFileRepository.findChunkedFilesByScope(prefixScope);
    expect(result).toEqual([{ id: ownerFile._id.toString(), userId: 'owner' }]);
  });
});

describe('FabFileRepository.findConvergencePausedFilesByScope', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('finds the shape neither other read can see: chunkless, no error, marker set', async () => {
    // What a halted wave leaves behind. `findChunkedFilesByScope` needs chunked:true and
    // `countFailedFilesByScope` needs a non-empty error, so without this read the rebuild door
    // reported underChunkedCount 0 and hid its own button on the lake that needed it.
    const [stranded] = await FabFile.create([
      makeFile({ userId: 'u1', chunked: false, chunkCount: 0, error: null, notes: CONVERGENCE_PAUSED_CHUNK_NOTE }),
    ]);
    await FabFile.create([
      makeFile({ userId: 'u1', chunked: false, chunkCount: 0 }), // chunkless, but never had passages
      // Marker outlived a rescue-sweep rebuild (that path never resets, so `notes` survives) - the
      // file is healthy again and must NOT be re-selected.
      makeFile({ userId: 'u1', chunkCount: 4, notes: CONVERGENCE_PAUSED_CHUNK_NOTE }),
      makeFile({ userId: 'u2', chunkCount: 0, notes: CONVERGENCE_PAUSED_CHUNK_NOTE, isChunking: true }),
      makeFile({ userId: 'u2', chunkCount: 0, notes: CONVERGENCE_PAUSED_CHUNK_NOTE, deletedAt: new Date() }),
      makeFile({
        userId: 'u3',
        chunkCount: 0,
        notes: CONVERGENCE_PAUSED_CHUNK_NOTE,
        tags: [{ name: 'datalake:other', strength: 1 }],
      }),
    ]);

    const result = await fabFileRepository.findConvergencePausedFilesByScope(scope);
    expect(result).toEqual([{ id: stranded._id.toString(), userId: 'u1' }]);
  });
});

describe('FabFileRepository.resetChunkStateByIds', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('resets the chunk/vector flags INCLUDING error, so a re-enqueued job re-chunks', async () => {
    const [f] = await FabFile.create([
      makeFile({
        chunked: true,
        chunkCount: 1,
        isChunking: false,
        vectorized: true,
        vectorizedChunkCount: 1,
        // A file that chunked then FAILED vectorization: chunked:true + a stale error. If the reset
        // leaves `error` set, the file is stranded - invisible to re-detection (needs chunked:true)
        // AND to the rescue sweep (needs empty error). This assertion is the guard on that.
        error: 'vectorize timeout',
        chunkEmbeddingModelStampedAt: new Date(),
      }),
    ]);

    expect(await fabFileRepository.resetChunkStateByIds([f._id.toString()])).toEqual([f._id.toString()]);

    const after = await FabFile.findById(f._id).lean();
    expect(after?.isChunking).toBe(false); // NOT a claim - the worker's CAS owns exclusion
    expect(after?.chunked).toBe(false);
    expect(after?.chunkCount).toBe(0);
    expect(after?.vectorized).toBe(false);
    expect(after?.vectorizedChunkCount).toBe(0);
    expect(after?.error).toBeNull();
    expect(after?.chunkEmbeddingModelStampedAt).toBeNull();
  });

  it('SKIPS a file a worker is mid-run on, so the reset cannot release a live lease', async () => {
    // The round-8 P1. The reset WRITES isChunking:false, so without the precondition it releases a
    // worker's claim and lets a second worker into chunkFabfile's delete-then-insert. The id must
    // also be absent from the return value, or the caller enqueues a file it did not reset.
    const [busy] = await FabFile.create([makeFile({ chunked: true, chunkCount: 1, isChunking: true })]);
    const [free] = await FabFile.create([makeFile({ chunked: true, chunkCount: 1, isChunking: false })]);

    const reset = await fabFileRepository.resetChunkStateByIds([busy._id.toString(), free._id.toString()]);

    expect(reset).toEqual([free._id.toString()]);
    const after = await FabFile.findById(busy._id).lean();
    expect(after?.isChunking).toBe(true); // lease survived
    expect(after?.chunked).toBe(true); // and its chunks were not un-flagged
  });

  it('an empty id list is a no-op', async () => {
    expect(await fabFileRepository.resetChunkStateByIds([])).toEqual([]);
  });
});

// The handoff the mocked worker tests cannot see: a producer resets a file, and the worker's claim
// must then actually acquire it. A previous round added an `isChunking:{$ne:true}` precondition to a
// path whose producer SET isChunking:true, so every message was rejected and nothing was ever
// re-chunked - green CI throughout, because the worker suite mocks findOneAndUpdate. These run the
// real query against a real document.
describe('reset -> worker claim handoff (real DB)', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  const STALE_MS = 30 * 60_000;
  // Byte-for-byte the claim in apps/client/server/queueHandlers/fabFileChunk.ts. If that query
  // changes, this must change with it - which is the point.
  const workerClaim = async (id: string) => {
    const now = new Date();
    const staleClaimBefore = new Date(now.getTime() - STALE_MS);
    return FabFile.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { isChunking: { $ne: true } },
          { isChunking: true, chunkClaimedAt: { $lt: staleClaimBefore } },
          { isChunking: true, chunkClaimedAt: null },
        ],
      },
      { $set: { isChunking: true, chunkClaimedAt: now } }
    );
  };

  it('the worker ACQUIRES a file the producer just reset', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: true, chunkCount: 1 })]);
    const id = f._id.toString();
    await fabFileRepository.resetChunkStateByIds([id]);

    expect(await workerClaim(id)).not.toBeNull();
    expect((await FabFile.findById(id).lean())?.isChunking).toBe(true);
  });

  it('a CONCURRENT duplicate delivery loses the claim and must not run', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: true, chunkCount: 1 })]);
    const id = f._id.toString();
    await fabFileRepository.resetChunkStateByIds([id]);

    expect(await workerClaim(id)).not.toBeNull(); // delivery 1 wins
    expect(await workerClaim(id)).toBeNull(); // delivery 2 finds it in flight
  });

  it('an SQS retry re-acquires once the first attempt released the claim', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: true, chunkCount: 1 })]);
    const id = f._id.toString();
    await fabFileRepository.resetChunkStateByIds([id]);

    expect(await workerClaim(id)).not.toBeNull();
    // What the handler's `finally` does on every exit.
    await FabFile.updateOne({ _id: id }, { $set: { isChunking: false } });
    expect(await workerClaim(id)).not.toBeNull(); // retry ladder survives
  });

  it('a SUPERSEDED run releasing does not clear its successor claim', async () => {
    // The release is a CAS on the stamp the run claimed with. Without that, run A's `finally` clears
    // the flag of whoever re-claimed after it (the stale arm, or a later wave), re-opening arm 1 for
    // a third worker while the second is still inside chunkFabfile - one takeover becomes a cascade.
    const [f] = await FabFile.create([makeFile({ chunked: false, chunkCount: 0 })]);
    const id = f._id.toString();

    const aStamp = new Date(Date.now() - 60 * 60_000);
    await FabFile.updateOne({ _id: id }, { $set: { isChunking: true, chunkClaimedAt: aStamp } });

    // B supersedes A via the stale arm, taking a fresh stamp.
    expect(await workerClaim(id)).not.toBeNull();

    // A now finishes and runs its release, matched on ITS stamp.
    await FabFile.updateOne({ _id: id, chunkClaimedAt: aStamp }, { $set: { isChunking: false } });

    expect((await FabFile.findById(id).lean())?.isChunking).toBe(true); // B still holds it
  });

  it('a claim stranded by a hard crash is reclaimable once stale', async () => {
    const [f] = await FabFile.create([
      makeFile({ chunked: false, chunkCount: 0, isChunking: true, chunkClaimedAt: new Date(Date.now() - 60 * 60_000) }),
    ]);
    expect(await workerClaim(f._id.toString())).not.toBeNull();
  });
});

describe('FabFileRepository.countFailedFilesByScope', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('counts lake files with an error and no chunks, ignoring healthy / empty-error / deleted / pending / non-member', async () => {
    await FabFile.create([
      makeFile({ chunked: false, chunkCount: 0, error: 'corrupt pdf' }), // counts
      makeFile({ chunked: false, chunkCount: 0, error: 'unparseable' }), // counts
      makeFile({ chunked: true, chunkCount: 5 }), // healthy -> no
      makeFile({ chunked: false, chunkCount: 0, error: '' }), // empty error -> no
      makeFile({ chunked: false, chunkCount: 0, error: 'x', deletedAt: new Date() }), // deleted -> no
      makeFile({ chunked: false, chunkCount: 0, error: 'mid-upload', status: 'pending' }), // still uploading -> no
      makeFile({ chunked: false, chunkCount: 0, error: 'y', tags: [{ name: 'datalake:other', strength: 1 }] }), // non-member -> no
    ]);

    expect(await fabFileRepository.countFailedFilesByScope(scope)).toBe(2);
  });
});
