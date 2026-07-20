import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// Real-Mongo round-trips for the restrictToFileIds allow-list: proves the restriction
// holds through Mongoose _id casting and the executeSearch pipeline, not just the
// query-builder object shape (covered in fabFileSearchQuery.test.ts).
describe('FabFileRepository.search restrictToFileIds allow-list', () => {
  setupMongoTest();

  const userId = 'restrict-test-user';
  const pagination = { page: 1, limit: 20 };
  const order = { by: 'fileName', direction: 'asc' } as const;

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  async function seedThreeMatchingFiles(): Promise<string[]> {
    const docs = await FabFile.create(
      ['widget-alpha.txt', 'widget-beta.txt', 'widget-gamma.txt'].map(fileName => ({
        userId,
        fileName,
        type: KnowledgeType.FILE,
        mimeType: 'text/plain',
      }))
    );
    return docs.map(d => d.id as string);
  }

  it('returns ONLY allow-listed files even when other files match for the same user', async () => {
    const [alphaId, betaId] = await seedThreeMatchingFiles();

    const result = await fabFileRepository.search(
      userId,
      'widget',
      { restrictToFileIds: [alphaId, betaId] },
      pagination,
      order
    );

    expect(result.total).toBe(2);
    expect(result.data.map(f => f.id).sort()).toEqual([alphaId, betaId].sort());
  });

  it('an empty allow-list returns nothing (fail-closed), never the unrestricted set', async () => {
    await seedThreeMatchingFiles();

    const result = await fabFileRepository.search(userId, 'widget', { restrictToFileIds: [] }, pagination, order);

    expect(result.total).toBe(0);
    expect(result.data).toEqual([]);
  });

  it('nonexistent ids in the allow-list return nothing rather than erroring', async () => {
    await seedThreeMatchingFiles();

    const result = await fabFileRepository.search(
      userId,
      'widget',
      { restrictToFileIds: ['64b000000000000000000000'] },
      pagination,
      order
    );

    expect(result.total).toBe(0);
  });

  it('still applies the owner filter: an allow-listed id owned by ANOTHER user is not returned', async () => {
    const [alphaId] = await seedThreeMatchingFiles();
    const foreign = await FabFile.create({
      userId: 'someone-else',
      fileName: 'widget-foreign.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
    });

    const result = await fabFileRepository.search(
      userId,
      'widget',
      { restrictToFileIds: [alphaId, foreign.id as string] },
      pagination,
      order,
      { includeShared: false }
    );

    expect(result.data.map(f => f.id)).toEqual([alphaId]);
  });
});
