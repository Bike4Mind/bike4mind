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

  // No count on the fixtures, because a tag document does not carry one. Every number asserted
  // below is therefore produced by listFileTags itself rather than read off the document.
  const tag = (name: string): IFileTag =>
    ({
      id: `tag-${name}`,
      userId,
      name,
      type: TagType.FILE,
      lastActivityAt: new Date(),
    }) as IFileTag;

  beforeEach(() => {
    mockFileTagRepo = { findAllByUserId: vi.fn() };
    mockFabFileRepo = { countFilesByTagForUser: vi.fn() };
    adapters = { db: { fileTags: mockFileTagRepo, fabFiles: mockFabFileRepo } };
  });

  it('computes the count from the live aggregate', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('invoices')]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([{ tag: 'invoices', count: 2 }]);

    const result = await listFileTags(userId, params, adapters);

    expect(result).toHaveLength(1);
    expect(result[0].fileCount).toBe(2);
  });

  // toggleTags lowercases what it writes onto files, tagService/create keeps the casing the user
  // typed, so the common shape is a capitalised document over lowercase file tags.
  it('matches case-insensitively when no document claims the bucket exactly', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('Invoices')]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([
      { tag: 'invoices', count: 2 },
      { tag: 'INVOICES', count: 1 },
    ]);

    const result = await listFileTags(userId, params, adapters);

    expect(result[0].fileCount).toBe(3);
  });

  // The unique index is { userId, name } with no collation, so these are two real documents.
  // Folding them together would credit each with the other's files and double-count the surface.
  it('keeps documents that differ only in case on their own exact counts', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('Invoices'), tag('invoices')]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([
      { tag: 'Invoices', count: 3 },
      { tag: 'invoices', count: 2 },
    ]);

    const result = await listFileTags(userId, params, adapters);

    expect(result.map(t => t.fileCount)).toEqual([3, 2]);
  });

  it('drops a bucket it cannot attribute rather than crediting both candidates', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('Invoices'), tag('invoices')]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([
      { tag: 'Invoices', count: 3 },
      { tag: 'invoices', count: 2 },
      { tag: 'INVOICES', count: 9 },
    ]);

    const result = await listFileTags(userId, params, adapters);

    expect(result.map(t => t.fileCount)).toEqual([3, 2]);
  });

  it('adds unclaimed case variants to the single document that folds to them', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('invoices')]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([
      { tag: 'invoices', count: 2 },
      { tag: 'Invoices', count: 3 },
    ]);

    const result = await listFileTags(userId, params, adapters);

    expect(result[0].fileCount).toBe(5);
  });

  it('reports zero for a tag no live file carries', async () => {
    (mockFileTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tag('orphaned')]);
    (mockFabFileRepo.countFilesByTagForUser as Mock).mockResolvedValueOnce([{ tag: 'something-else', count: 4 }]);

    const result = await listFileTags(userId, params, adapters);

    expect(result[0].fileCount).toBe(0);
  });

  it('preserves the rest of the tag document', async () => {
    const stored = tag('invoices');
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
