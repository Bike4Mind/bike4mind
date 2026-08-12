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

  it('claims the file (isChunking:true) and resets the chunk/vector flags', async () => {
    const [f] = await FabFile.create([
      makeFile({
        chunked: true,
        chunkCount: 1,
        isChunking: false,
        vectorized: true,
        vectorizedChunkCount: 1,
        chunkEmbeddingModelStampedAt: new Date(),
      }),
    ]);

    expect(await fabFileRepository.claimFilesForRechunkByIds([f._id.toString()])).toBe(1);

    const after = await FabFile.findById(f._id).lean();
    expect(after?.isChunking).toBe(true); // claimed, so the rescue sweep can't grab it mid-flight
    expect(after?.chunked).toBe(false);
    expect(after?.chunkCount).toBe(0);
    expect(after?.vectorized).toBe(false);
    expect(after?.vectorizedChunkCount).toBe(0);
    expect(after?.chunkEmbeddingModelStampedAt).toBeNull();
  });

  it('an empty id list is a no-op', async () => {
    expect(await fabFileRepository.claimFilesForRechunkByIds([])).toBe(0);
  });
});

describe('FabFileRepository.releaseChunkClaimByIds', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('releases the claim and restores chunked:true so the file is re-detectable', async () => {
    const [f] = await FabFile.create([makeFile({ chunked: false, isChunking: true, chunkCount: 0 })]);

    expect(await fabFileRepository.releaseChunkClaimByIds([f._id.toString()])).toBe(1);

    const after = await FabFile.findById(f._id).lean();
    expect(after?.isChunking).toBe(false);
    expect(after?.chunked).toBe(true);
  });
});

describe('FabFileRepository.countFailedFilesByScope', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('counts lake files with an error and no chunks, ignoring healthy / empty-error / deleted / non-member', async () => {
    await FabFile.create([
      makeFile({ chunked: false, chunkCount: 0, error: 'corrupt pdf' }), // counts
      makeFile({ chunked: false, chunkCount: 0, error: 'unparseable' }), // counts
      makeFile({ chunked: true, chunkCount: 5 }), // healthy -> no
      makeFile({ chunked: false, chunkCount: 0, error: '' }), // empty error -> no
      makeFile({ chunked: false, chunkCount: 0, error: 'x', deletedAt: new Date() }), // deleted -> no
      makeFile({ chunked: false, chunkCount: 0, error: 'y', tags: [{ name: 'datalake:other', strength: 1 }] }), // non-member -> no
    ]);

    expect(await fabFileRepository.countFailedFilesByScope(scope)).toBe(2);
  });
});
