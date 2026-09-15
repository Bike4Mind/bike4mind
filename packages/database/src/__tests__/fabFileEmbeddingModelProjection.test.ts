import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// Embedding-mismatch detection in the data-lake retrieval paths reads embeddingModel (and
// vectorizedChunkCount) off the file metadata both entrypoints already load. Neither projection
// may drop them.
//
// This has its own file because the failure mode is silent and fails OPEN: strip embeddingModel
// from a projection and every file reads as unlabeled, so nothing is ever detected as foreign,
// retrieval quietly goes back to cross-space scoring, and no other test in the suite goes red.
describe('FabFile projections preserve embedding-model metadata', () => {
  setupMongoTest();

  const userId = 'embedding-projection-user';
  const pagination = { page: 1, limit: 20 };
  const order = { by: 'fileName', direction: 'asc' } as const;

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  const seed = () =>
    FabFile.create({
      userId,
      fileName: 'labeled.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      embeddingModel: 'text-embedding-3-small',
      vectorizedChunkCount: 7,
      vectorized: true,
    });

  it('keeps them through search with excludeContent (the tag-scoped browse projection)', async () => {
    await seed();

    const result = await fabFileRepository.search(userId, '', {}, pagination, order, {
      textSearch: false,
      excludeContent: true,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].embeddingModel).toBe('text-embedding-3-small');
    expect(result.data[0].vectorizedChunkCount).toBe(7);
  });

  it('keeps them through getAccessibleFiles (the agent-scope projection)', async () => {
    const doc = await seed();

    const files = await fabFileRepository.getAccessibleFiles([doc.id as string], {
      deletedAt: null,
      archivedAt: null,
    });

    expect(files).toHaveLength(1);
    expect(files[0].embeddingModel).toBe('text-embedding-3-small');
    expect(files[0].vectorizedChunkCount).toBe(7);
  });

  it('reads back as unset, not as some default, for a file that predates the field', async () => {
    // The legacy corpus depends on this: an absent label must stay absent so detection can give
    // it the benefit of the doubt rather than excluding it.
    await FabFile.create({
      userId,
      fileName: 'legacy.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
    });

    const result = await fabFileRepository.search(userId, '', {}, pagination, order, {
      textSearch: false,
      excludeContent: true,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].embeddingModel).toBeUndefined();
  });
});
