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
      // f-big: one huge chunk (legacy blob)
      { fabFileId: 'f-big', text: 'a', tokenCount: 6000 },
      { fabFileId: 'f-big', text: 'b', tokenCount: 400 },
      // f-mid: over the threshold but smaller than f-big
      { fabFileId: 'f-mid', text: 'c', tokenCount: 2000 },
      // f-ok: correctly chunked, never over threshold
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

    const ids = await fabFileChunkRepository.findUnderChunkedFabFileIds(['in'], 1500);

    expect(ids).toEqual(['in']);
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

  it('returns chunked lake files as {id, userId}, excluding unchunked / deleted / archived / non-member', async () => {
    const [member, unchunked] = await FabFile.create([
      makeFile({ userId: 'u1' }),
      makeFile({ userId: 'u1', chunked: false }),
    ]);
    await FabFile.create([
      makeFile({ userId: 'u2', deletedAt: new Date() }),
      makeFile({ userId: 'u2', archivedAt: new Date() }),
      makeFile({ userId: 'u3', tags: [{ name: 'datalake:other', strength: 1 }] }),
    ]);

    const result = await fabFileRepository.findChunkedFilesByScope(scope);

    expect(result).toEqual([{ id: member._id.toString(), userId: 'u1' }]);
    // sanity: the unchunked member is a real lake file but must not appear
    expect(result.some(r => r.id === unchunked._id.toString())).toBe(false);
  });
});

describe('FabFileRepository.resetChunkStateByIds', () => {
  setupMongoTest();
  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('clears the chunk/vector processing flags so a re-enqueued job re-chunks', async () => {
    const [f] = await FabFile.create([
      makeFile({
        chunked: true,
        chunkCount: 1,
        vectorized: true,
        vectorizedChunkCount: 1,
        chunkEmbeddingModelStampedAt: new Date(),
      }),
    ]);

    const modified = await fabFileRepository.resetChunkStateByIds([f._id.toString()]);
    expect(modified).toBe(1);

    const after = await FabFile.findById(f._id).lean();
    expect(after?.chunked).toBe(false);
    expect(after?.chunkCount).toBe(0);
    expect(after?.vectorized).toBe(false);
    expect(after?.vectorizedChunkCount).toBe(0);
    expect(after?.chunkEmbeddingModelStampedAt).toBeNull();
  });

  it('an empty id list is a no-op', async () => {
    expect(await fabFileRepository.resetChunkStateByIds([])).toBe(0);
  });
});
