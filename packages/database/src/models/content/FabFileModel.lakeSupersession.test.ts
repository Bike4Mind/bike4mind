import { beforeEach, describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository as repo } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * The curator supersession marker (#3046) against real Mongo. The write is an update-then-insert
 * pair rather than a single positional update, and the properties that buys - first ruling and re-ruling on one
 * code path, at most one entry per lake, no cross-lake interference - are exactly the ones a mocked
 * repository cannot show.
 */
const ruling = (over: Partial<Parameters<typeof repo.setLakeSupersession>[1]> = {}) => ({
  dataLakeId: 'lake-1',
  supersededByFabFileId: 'winner-1',
  decidedByUserId: 'curator-1',
  decidedAt: new Date('2026-09-22T00:00:00Z'),
  ...over,
});

describe('FabFileRepository lake supersession', () => {
  setupMongoTest();

  let fileId: string;

  beforeEach(async () => {
    const doc = await FabFile.create({
      userId: 'owner-1',
      fileName: 'old.md',
      mimeType: 'text/markdown',
      type: KnowledgeType.FILE,
      filePath: 'old.md',
    });
    fileId = doc._id.toString();
  });

  // `supersededInLakes` is `select: false` - the raw driver assertions in this file opt back in
  // explicitly, same as the repository's own internal readers do.
  const stored = async () =>
    (await FabFile.findById(fileId).select('+supersededInLakes').lean())?.supersededInLakes ?? [];

  it('stores nothing until a curator rules', async () => {
    expect(await stored()).toEqual([]);
  });

  it('records a first ruling', async () => {
    expect(await repo.setLakeSupersession(fileId, ruling())).toBe(true);
    expect(await stored()).toMatchObject([
      { dataLakeId: 'lake-1', supersededByFabFileId: 'winner-1', decidedByUserId: 'curator-1' },
    ]);
  });

  it('replaces a re-ruling in the same lake rather than stacking a second entry', async () => {
    await repo.setLakeSupersession(fileId, ruling());
    await repo.setLakeSupersession(fileId, ruling({ supersededByFabFileId: 'winner-2', decidedByUserId: 'curator-2' }));

    const entries = await stored();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ supersededByFabFileId: 'winner-2', decidedByUserId: 'curator-2' });
  });

  it('keeps one entry per lake, so a ruling in one lake does not disturb another', async () => {
    await repo.setLakeSupersession(fileId, ruling());
    await repo.setLakeSupersession(fileId, ruling({ dataLakeId: 'lake-2', supersededByFabFileId: 'winner-9' }));

    expect(await stored()).toMatchObject([
      { dataLakeId: 'lake-1', supersededByFabFileId: 'winner-1' },
      { dataLakeId: 'lake-2', supersededByFabFileId: 'winner-9' },
    ]);
  });

  it('clears the ruling for only the named lake', async () => {
    await repo.setLakeSupersession(fileId, ruling());
    await repo.setLakeSupersession(fileId, ruling({ dataLakeId: 'lake-2' }));

    expect(await repo.clearLakeSupersession(fileId, 'lake-1')).toBe(true);
    expect(await stored()).toMatchObject([{ dataLakeId: 'lake-2' }]);
  });

  it('reports false when clearing a ruling that was never made', async () => {
    expect(await repo.clearLakeSupersession(fileId, 'lake-1')).toBe(false);
  });

  it('reports false when the file does not exist', async () => {
    expect(await repo.setLakeSupersession('64b7f9c2d1e4a5b6c7d8e9f0', ruling())).toBe(false);
  });

  it('is select:false - a plain findById does not surface it', async () => {
    await repo.setLakeSupersession(fileId, ruling());

    const found = await repo.findById(fileId);
    expect(found?.supersededInLakes).toBeUndefined();
  });

  it(
    'is visible through executeSearch (via search) when the caller opts in - the read the ' +
      'curator-supersession collapse actually depends on',
    async () => {
      await repo.setLakeSupersession(fileId, ruling());

      const withoutOptIn = await repo.search(
        'owner-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'fileName', direction: 'asc' },
        { textSearch: false }
      );
      expect(withoutOptIn.data.find(f => f.id === fileId)?.supersededInLakes).toBeUndefined();

      const withOptIn = await repo.search(
        'owner-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'fileName', direction: 'asc' },
        { textSearch: false, includeSupersessionRulings: true }
      );
      expect(withOptIn.data.find(f => f.id === fileId)?.supersededInLakes).toMatchObject([
        { dataLakeId: 'lake-1', supersededByFabFileId: 'winner-1', decidedByUserId: 'curator-1' },
      ]);
    }
  );

  it('getLakeSupersessionWinner returns the ruled winner for the named lake only', async () => {
    await repo.setLakeSupersession(fileId, ruling());
    await repo.setLakeSupersession(fileId, ruling({ dataLakeId: 'lake-2', supersededByFabFileId: 'winner-9' }));

    expect(await repo.getLakeSupersessionWinner!(fileId, 'lake-1')).toBe('winner-1');
    expect(await repo.getLakeSupersessionWinner!(fileId, 'lake-2')).toBe('winner-9');
    expect(await repo.getLakeSupersessionWinner!(fileId, 'lake-3')).toBeNull();
  });

  it('getLakeSupersessionWinner returns null for a file with no ruling or that does not exist', async () => {
    expect(await repo.getLakeSupersessionWinner!(fileId, 'lake-1')).toBeNull();
    expect(await repo.getLakeSupersessionWinner!('64b7f9c2d1e4a5b6c7d8e9f0', 'lake-1')).toBeNull();
  });
});
