import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, FabFileChunk, fabFileRepository, fabFileChunkRepository } from '../models/content/FabFileModel';
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
    await FabFileChunk.create([
      { fabFileId: 'f-big', text: 'a', tokenCount: 6000 },
      { fabFileId: 'f-big', text: 'b', tokenCount: 400 },
      { fabFileId: 'f-mid', text: 'c', tokenCount: 2000 },
      { fabFileId: 'f-ok', text: 'd', tokenCount: 500 },
      { fabFileId: 'f-ok', text: 'e', tokenCount: 480 },
    ]);

    const ids = await fabFileChunkRepository.findUnderChunkedFabFileIds(['f-big', 'f-mid', 'f-ok'], 1500);

    expect(ids).toEqual(['f-big', 'f-mid']); // worst-first, f-ok excluded
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

describe('FabFileRepository.claimFilesForRechunkByIds', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('claims a free file (isChunking:true + reset flags, incl. error) and returns its id + claim stamp', async () => {
    const [f] = await FabFile.create([
      makeFile({
        chunked: true,
        chunkCount: 1,
        isChunking: false,
        vectorized: true,
        vectorizedChunkCount: 1,
        // A file that chunked then FAILED vectorization: chunked:true + a stale error. The claim
        // must clear that error, else a released claim strands it invisibly.
        error: 'vectorize timeout',
        chunkEmbeddingModelStampedAt: new Date(),
      }),
    ]);

    expect(await fabFileRepository.claimFilesForRechunkByIds([f._id.toString()])).toEqual([
      { id: f._id.toString(), claimedAt: expect.any(Number) },
    ]);

    const after = await FabFile.findById(f._id).lean();
    expect(after?.isChunking).toBe(true); // claimed, so the rescue sweep can't grab it mid-flight
    expect(after?.chunkClaimedAt).toBeInstanceOf(Date); // stamped so a lost claim is later reclaimable
    expect(after?.chunked).toBe(false);
    expect(after?.chunkCount).toBe(0);
    expect(after?.vectorized).toBe(false);
    expect(after?.vectorizedChunkCount).toBe(0);
    expect(after?.error).toBeNull(); // stale vectorize error cleared with the rest of the reset
    expect(after?.chunkEmbeddingModelStampedAt).toBeNull();
  });

  it('does NOT claim a file already in-flight (compare-and-set), so concurrent waves cannot double-claim', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: false, isChunking: true })]);
    // Second wave sees isChunking already set -> not returned -> caller never enqueues it again.
    expect(await fabFileRepository.claimFilesForRechunkByIds([f._id.toString()])).toEqual([]);
  });

  it('returns only the subset it won when some ids are already claimed', async () => {
    const [free, taken] = await FabFile.create([makeFile({ isChunking: false }), makeFile({ isChunking: true })]);
    expect(await fabFileRepository.claimFilesForRechunkByIds([free._id.toString(), taken._id.toString()])).toEqual([
      { id: free._id.toString(), claimedAt: expect.any(Number) },
    ]);
  });

  it('an empty id list is a no-op', async () => {
    expect(await fabFileRepository.claimFilesForRechunkByIds([])).toEqual([]);
  });
});

describe('FabFileRepository.claimForChunkScanByIds', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  const staleBefore = () => new Date(Date.now() - 30 * 60_000);

  it('claims a free (not-in-flight) file, stamping isChunking + chunkClaimedAt', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: false, chunkCount: 0, isChunking: false })]);
    expect(await fabFileRepository.claimForChunkScanByIds([f._id.toString()], staleBefore())).toEqual([
      { id: f._id.toString(), claimedAt: expect.any(Number) },
    ]);
    const after = await FabFile.findById(f._id).lean();
    expect(after?.isChunking).toBe(true);
    expect(after?.chunkClaimedAt).toBeInstanceOf(Date);
  });

  it('reclaims a STALE claim (isChunking:true, chunkClaimedAt older than the cutoff)', async () => {
    const [f] = await FabFile.create([
      makeFile({ chunked: false, chunkCount: 0, isChunking: true, chunkClaimedAt: new Date(Date.now() - 60 * 60_000) }),
    ]);
    expect(await fabFileRepository.claimForChunkScanByIds([f._id.toString()], staleBefore())).toEqual([
      { id: f._id.toString(), claimedAt: expect.any(Number) },
    ]);
  });

  it('does NOT reclaim a FRESH in-flight claim (chunkClaimedAt within the cutoff)', async () => {
    const [f] = await FabFile.create([
      makeFile({ chunked: false, chunkCount: 0, isChunking: true, chunkClaimedAt: new Date() }),
    ]);
    expect(await fabFileRepository.claimForChunkScanByIds([f._id.toString()], staleBefore())).toEqual([]);
  });

  it('reclaims a null-stamp stuck claim (isChunking:true with no chunkClaimedAt) - the backfill arm', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: false, chunkCount: 0, isChunking: true })]);
    const after0 = await FabFile.findById(f._id).lean();
    expect(after0?.chunkClaimedAt ?? null).toBeNull(); // stuck before chunkClaimedAt existed
    expect(await fabFileRepository.claimForChunkScanByIds([f._id.toString()], staleBefore())).toEqual([
      { id: f._id.toString(), claimedAt: expect.any(Number) },
    ]);
  });

  it('an empty id list is a no-op', async () => {
    expect(await fabFileRepository.claimForChunkScanByIds([], staleBefore())).toEqual([]);
  });
});

describe('FabFileRepository.releaseChunkClaimByIds', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('clears only isChunking, leaving the file reset so the sweep re-chunks it rather than churns', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: false, isChunking: true, chunkCount: 0 })]);

    expect(await fabFileRepository.releaseChunkClaimByIds([f._id.toString()])).toBe(1);

    const after = await FabFile.findById(f._id).lean();
    expect(after?.isChunking).toBe(false);
    // chunked stays false (NOT restored to true): the released file is genuinely under-chunked, so
    // the rescue sweep picks it up and the worker actually re-chunks it instead of no-op churning.
    expect(after?.chunked).toBe(false);
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
