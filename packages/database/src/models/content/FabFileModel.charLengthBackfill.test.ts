import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, FabFileChunk, fabFileChunkRepository, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const makeChunk = (fabFileId: string, text: string, charLength?: number) =>
  FabFileChunk.create({
    fabFileId,
    text,
    tokenCount: 1,
    ...(charLength !== undefined ? { charLength } : {}),
  });

const makeFile = (fileName: string, extra: Record<string, unknown> = {}) =>
  FabFile.create({ userId: 'u1', fileName, type: KnowledgeType.TEXT, ...extra });

describe('charLength backfill primitives', () => {
  setupMongoTest();

  it('pages chunk ids still missing charLength, ascending by _id', async () => {
    const a = await makeChunk('f1', 'aaa');
    await makeChunk('f1', 'stamped', 7);
    const c = await makeChunk('f2', 'cc');

    const ids = await fabFileChunkRepository.findChunkIdsMissingCharLength();
    expect(ids).toEqual([String(a._id), String(c._id)]);

    const page = await fabFileChunkRepository.findChunkIdsMissingCharLength({
      limit: 1,
      afterChunkId: String(a._id),
    });
    expect(page).toEqual([String(c._id)]);
  });

  it('stamps charLength server-side in CODE POINTS and reruns find nothing (idempotent)', async () => {
    const emoji = '\u{1F600}';
    const chunk = await makeChunk('f1', `four${emoji}`); // 5 code points, 6 UTF-16 units

    const ids = await fabFileChunkRepository.findChunkIdsMissingCharLength();
    const modified = await fabFileChunkRepository.backfillCharLengthByIds(ids);
    expect(modified).toBe(1);

    const stored = await FabFileChunk.findById(chunk._id).lean();
    expect(stored?.charLength).toBe(5);

    expect(await fabFileChunkRepository.findChunkIdsMissingCharLength()).toEqual([]);
    expect(await fabFileChunkRepository.backfillCharLengthByIds([])).toBe(0);
  });

  it('sums a file chunks charLength treating an unstamped chunk as 0', async () => {
    await makeChunk('f1', 'aaa', 3);
    await makeChunk('f1', 'bbbb', 4);
    await makeChunk('f1', 'not-yet-stamped');
    await makeChunk('f2', 'other-file', 100);

    expect(await fabFileChunkRepository.sumChunkCharLengthByFabFileId('f1')).toBe(7);
    expect(await fabFileChunkRepository.sumChunkCharLengthByFabFileId('missing')).toBe(0);
  });

  it('pages files that have chunks but no chunkedCharCount, and setChunkedCharCount removes them', async () => {
    const missing = await makeFile('missing.txt', { chunkCount: 2 });
    await makeFile('stamped.txt', { chunkCount: 2, chunkedCharCount: 7 });
    await makeFile('chunkless.txt', { chunkCount: 0 });
    // Nulled by a content rewrite - must be picked up again:
    const nulled = await makeFile('nulled.txt', { chunkCount: 1, chunkedCharCount: null });

    const ids = await fabFileRepository.findFileIdsMissingChunkedCharCount();
    expect(ids).toEqual([String(missing._id), String(nulled._id)]);

    await fabFileRepository.setChunkedCharCount(String(missing._id), 9);
    expect(await fabFileRepository.findFileIdsMissingChunkedCharCount()).toEqual([String(nulled._id)]);
  });
});
