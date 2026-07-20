import { describe, it, expect, beforeEach } from 'vitest';
import { FabFileChunk, fabFileChunkRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';

// DB-layer guarantee the file-scoped semantic search relies on: the bulk vector load
// returns chunks ONLY for the requested file ids, and only vector-bearing ones.
describe('FabFileChunkRepository.findVectorsByFabFileIds scoping', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('returns chunks only for the requested file ids', async () => {
    await FabFileChunk.create([
      { fabFileId: 'in-scope', text: 'in scope chunk', tokenCount: 4, vector: [0.1, 0.2] },
      { fabFileId: 'out-of-scope', text: 'other owner chunk', tokenCount: 4, vector: [0.3, 0.4] },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds(['in-scope']);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].fabFileId).toBe('in-scope');
  });

  it('excludes vectorless chunks of in-scope files', async () => {
    await FabFileChunk.create([
      { fabFileId: 'in-scope', text: 'vectorized', tokenCount: 2, vector: [0.1, 0.2] },
      { fabFileId: 'in-scope', text: 'not vectorized', tokenCount: 3, vector: [] },
      { fabFileId: 'in-scope', text: 'never vectorized', tokenCount: 3 },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds(['in-scope']);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('vectorized');
  });

  it('an empty id list returns nothing', async () => {
    await FabFileChunk.create([{ fabFileId: 'somewhere', text: 'chunk', tokenCount: 1, vector: [0.1] }]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([]);

    expect(chunks).toEqual([]);
  });
});
