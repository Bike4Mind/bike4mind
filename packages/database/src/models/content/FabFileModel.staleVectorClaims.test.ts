import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, FabFileChunk, fabFileChunkRepository, fabFileRepository } from './FabFileModel';
import { setupMongoTest, testFabFileId as fid } from '../../__test__/utils';

const makeFile = (fileName: string, extra: Record<string, unknown> = {}) =>
  FabFile.create({ userId: 'u1', fileName, type: KnowledgeType.TEXT, status: 'complete', ...extra });

/**
 * The #2583 detection primitives: which files DECLARE vectorized chunks, and which of those have
 * any chunk rows at all. Pairing the two finds a file whose count is stale - vectorizedChunkCount
 * counts chunks that are no longer there.
 */
describe('stale vector claim detection (#2583)', () => {
  setupMongoTest();

  it('findFileIdsWithPositiveVectorizedCount selects only files with a positive count', async () => {
    const vectorized = await makeFile('vectorized.txt', { chunkCount: 2, vectorizedChunkCount: 2 });
    await makeFile('never-vectorized.txt', { chunkCount: 2, vectorizedChunkCount: 0 });
    await makeFile('image.txt', {});

    const page = await fabFileRepository.findFileIdsWithPositiveVectorizedCount();
    expect(page).toEqual([{ id: String(vectorized._id), fileName: 'vectorized.txt' }]);
  });

  it('findFileIdsWithPositiveVectorizedCount pages forward on afterFileId and terminates', async () => {
    // The sweep's only loop-exit is an empty page, so `afterFileId` is the sole thing advancing it
    // (see collectStaleVectorClaims.ts). A cursor that did not move past the last id of a page -
    // `$gte` instead of `$gt`, or a cast that silently matched nothing - would either spin forever
    // or stop after one page. Nothing else exercises `limit`/`afterFileId` at all.
    const created = [];
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      created.push(await makeFile(name, { chunkCount: 1, vectorizedChunkCount: 1 }));
    }
    const idsInOrder = created.map(f => String(f._id)).sort();

    const seen: string[] = [];
    let afterFileId: string | undefined;
    for (;;) {
      const page = await fabFileRepository.findFileIdsWithPositiveVectorizedCount({ limit: 2, afterFileId });
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(2);
      afterFileId = page[page.length - 1].id;
      seen.push(...page.map(f => f.id));
    }

    // Every candidate exactly once, in id order, and the loop ended.
    expect(seen).toEqual(idsInOrder);
  });

  it('findFabFileIdsWithChunks returns exactly the candidate ids that have a chunk row', async () => {
    await FabFileChunk.create({ fabFileId: fid('has-chunks'), text: 't', tokenCount: 1 });

    const withChunks = await fabFileChunkRepository.findFabFileIdsWithChunks([fid('has-chunks'), fid('chunkless')]);
    expect(withChunks).toEqual(new Set([fid('has-chunks')]));
    expect(await fabFileChunkRepository.findFabFileIdsWithChunks([])).toEqual(new Set());
  });

  it('together, flag a file that declares vectorized chunks it does not have', async () => {
    // Healthy: real chunks back the count.
    const healthy = await makeFile('healthy.txt', { chunkCount: 1, vectorizedChunkCount: 1 });
    await FabFileChunk.create({ fabFileId: String(healthy._id), text: 't', tokenCount: 1, vector: [0.1] });

    // Stranded (#2583's mechanism): the count survived a chunk delete that the file row did not.
    const stranded = await makeFile('stranded.txt', { chunkCount: 3, vectorizedChunkCount: 3 });

    const candidates = await fabFileRepository.findFileIdsWithPositiveVectorizedCount();
    const withChunks = await fabFileChunkRepository.findFabFileIdsWithChunks(candidates.map(c => c.id));
    const stale = candidates.filter(c => !withChunks.has(c.id));

    expect(stale).toEqual([{ id: String(stranded._id), fileName: 'stranded.txt' }]);
  });
});
