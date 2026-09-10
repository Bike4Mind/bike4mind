import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, FabFileChunk, fabFileChunkRepository, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

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

  it('findFabFileIdsWithChunks returns exactly the candidate ids that have a chunk row', async () => {
    await FabFileChunk.create({ fabFileId: 'has-chunks', text: 't', tokenCount: 1 });

    const withChunks = await fabFileChunkRepository.findFabFileIdsWithChunks(['has-chunks', 'chunkless']);
    expect(withChunks).toEqual(new Set(['has-chunks']));
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
