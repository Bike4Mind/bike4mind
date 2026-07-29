import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { listFileTags } from './listFileTags';
import { IFabFileRepository, IFileTag, IFileTagRepository, TagType } from '@bike4mind/common';

describe('tagService - listFileTags', () => {
  const userId = 'test-user-123';
  const params = { userGroups: ['group-a'], dataLakeTags: ['datalake:org:mylake'] };

  let mockFileTagRepo: Pick<IFileTagRepository, 'findAllByUserId'>;
  let mockFabFileRepo: Pick<IFabFileRepository, 'countFilesByTagForUser'>;
  let adapters: {
    db: {
      fileTags: Pick<IFileTagRepository, 'findAllByUserId'>;
      fabFiles: Pick<IFabFileRepository, 'countFilesByTagForUser'>;
    };
  };

  // `fileCount` is deliberately wrong on every fixture tag: that stale value is exactly what the
  // unmaintained write paths leave behind, so a test asserting on it would pass against the bug.
  const tag = (name: string, storedFileCount: number): IFileTag =>
    ({
      id: `tag-${name}`,
      userId,
      name,
      type: TagType.FILE,
      fileCount: storedFileCount,
      lastActivityAt: new Date(),
    }) as IFileTag;

  beforeEach(() => {
    mockFileTagRepo = { findAllByUserId: vi.fn() };
    mockFabFileRepo = { countFilesByTagForUser: vi.fn() };
    adapters = { db: { fileTags: mockFileTagRepo, fabFiles: mockFabFileRepo } };
  });

  it('returns the live aggregate count, not the drifted stored counter', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('invoices', 99)]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([{ tag: 'invoices', count: 2 }]);

    const result = await listFileTags(userId, params, adapters);

    expect(result).toHaveLength(1);
    expect(result[0].fileCount).toBe(2);
  });

  it('sums aggregate buckets that differ only in case', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('Invoices', 0)]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([
      { tag: 'invoices', count: 2 },
      { tag: 'Invoices', count: 3 },
      { tag: 'INVOICES', count: 1 },
    ]);

    const result = await listFileTags(userId, params, adapters);

    expect(result[0].fileCount).toBe(6);
  });

  it('reports zero for a tag no live file carries', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('orphaned', 7)]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([{ tag: 'something-else', count: 4 }]);

    const result = await listFileTags(userId, params, adapters);

    expect(result[0].fileCount).toBe(0);
  });

  it('preserves the rest of the tag document', async () => {
    const stored = tag('invoices', 99);
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([stored]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([{ tag: 'invoices', count: 2 }]);

    const result = await listFileTags(userId, params, adapters);

    expect(result[0]).toEqual({ ...stored, fileCount: 2 });
  });

  it('scopes the aggregate to the caller and their shared/data-lake reach', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([]);

    await listFileTags(userId, params, adapters);

    expect(mockFabFileRepo.countFilesByTagForUser).toHaveBeenCalledWith(userId, {
      userGroups: ['group-a'],
      dataLakeTags: ['datalake:org:mylake'],
    });
  });

  it('returns an empty list when the user has no tags', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([{ tag: 'invoices', count: 2 }]);

    await expect(listFileTags(userId, params, adapters)).resolves.toEqual([]);
  });
});
