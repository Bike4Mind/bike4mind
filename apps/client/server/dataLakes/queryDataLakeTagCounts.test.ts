import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The tag-count surface hands the counters every lake the caller can reach - and for an admin
 * that is every lake of every tenant. It needs each lake's document to anchor the membership
 * predicate's prefix arm to that lake's creator, and it used to fetch them one findOne per lake.
 * These pin the batched read: one call for the whole set, and the same per-lake scope built from
 * it, including a lake with no document at all.
 */

const h = vi.hoisted(() => ({
  findByDatalakeTags: vi.fn(),
  countDataLakeTagsByPrefix: vi.fn(),
  countDataLakeUniqueFilesByPrefix: vi.fn(),
  countDataLakeFilesByMembership: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { search: vi.fn() },
  dataLakeService: { isFallbackLake: vi.fn(), listDataLakes: vi.fn(), listAllDataLakes: vi.fn() },
}));

// Spread the real module: the barrel re-exports mongoose and much else that the import chain
// pulls in, and a bare object mock only surfaces that as an unrelated "no export defined" error.
vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    dataLakeRepository: { findByDatalakeTags: h.findByDatalakeTags },
    fabFileRepository: {
      countDataLakeTagsByPrefix: h.countDataLakeTagsByPrefix,
      countDataLakeUniqueFilesByPrefix: h.countDataLakeUniqueFilesByPrefix,
      countDataLakeFilesByMembership: h.countDataLakeFilesByMembership,
    },
  };
});

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));

import { queryDataLakeTagCounts } from './index';

const req = { user: { id: 'viewer-9', groups: ['group-a'], tags: ['Opti'] } } as any;

const lake = (i: number) => ({ id: `lake-${i}`, datalakeTag: `datalake:lake-${i}`, fileTagPrefix: `lake${i}:` }) as any;

const scopes = () => h.countDataLakeFilesByMembership.mock.calls[0][0];

describe('queryDataLakeTagCounts lake-document lookup', () => {
  beforeEach(() => {
    h.findByDatalakeTags.mockReset().mockResolvedValue([]);
    h.countDataLakeTagsByPrefix.mockReset().mockResolvedValue([]);
    h.countDataLakeUniqueFilesByPrefix.mockReset().mockResolvedValue({ total: 0, byPrefix: {} });
    h.countDataLakeFilesByMembership.mockReset().mockResolvedValue({});
  });

  it('reads the lake documents in ONE call whatever the lake count', async () => {
    const lakes = Array.from({ length: 50 }, (_, i) => lake(i));

    await queryDataLakeTagCounts(req, lakes);

    expect(h.findByDatalakeTags).toHaveBeenCalledTimes(1);
    expect(h.findByDatalakeTags).toHaveBeenCalledWith(lakes.map(l => l.datalakeTag));
  });

  it('anchors each lake to its own document, whatever order they come back in', async () => {
    // `$in` gives no ordering guarantee, so the scopes are keyed by tag rather than by position -
    // getting that wrong would count one lake's files against another's creator.
    h.findByDatalakeTags.mockResolvedValue([
      { datalakeTag: 'datalake:lake-1', fileTagPrefix: 'stored1:', createdByUserId: 'creator-1' },
      { datalakeTag: 'datalake:lake-0', fileTagPrefix: 'stored0:', createdByUserId: 'creator-0' },
    ]);

    await queryDataLakeTagCounts(req, [lake(0), lake(1)]);

    expect(scopes()).toEqual([
      { datalakeTag: 'datalake:lake-0', fileTagPrefix: 'stored0:', creatorUserId: 'creator-0' },
      { datalakeTag: 'datalake:lake-1', fileTagPrefix: 'stored1:', creatorUserId: 'creator-1' },
    ]);
  });

  it('falls back to the config prefix and no creator for a lake with no document', async () => {
    // A static-registry lake never has one; meta-tag-only matching is the safe direction.
    h.findByDatalakeTags.mockResolvedValue([]);

    await queryDataLakeTagCounts(req, [lake(0)]);

    expect(scopes()).toEqual([{ datalakeTag: 'datalake:lake-0', fileTagPrefix: 'lake0:', creatorUserId: undefined }]);
  });

  it('skips the lookup entirely when the caller can reach no lakes', async () => {
    await expect(queryDataLakeTagCounts(req, [])).resolves.toEqual({
      tagCounts: [],
      uniqueArticleCounts: { total: 0, byPrefix: {} },
      lakeFileCounts: {},
    });
    expect(h.findByDatalakeTags).not.toHaveBeenCalled();
  });
});
