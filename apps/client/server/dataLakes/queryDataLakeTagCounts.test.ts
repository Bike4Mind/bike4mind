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
  countDataLakeFilesByMembershipArm: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { search: vi.fn() },
  dataLakeService: {
    isFallbackLake: vi.fn(),
    listDataLakes: vi.fn(),
    listAllDataLakes: vi.fn(),
    // The real shape, not a stub: these tests assert the emitted scope, so a vi.fn() returning
    // undefined would let a broken classifier pass.
    registryMembershipScope: (config: { datalakeTag: string; fileTagPrefix?: string | null }) => ({
      kind: 'registry' as const,
      datalakeTag: config.datalakeTag,
      fileTagPrefix: config.fileTagPrefix,
    }),
    warnIfManyLakeMemberships: vi.fn(),
  },
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
      countDataLakeFilesByMembershipArm: h.countDataLakeFilesByMembershipArm,
    },
  };
});

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));

import { DATA_LAKES } from '@bike4mind/common';
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
    h.countDataLakeFilesByMembershipArm.mockReset().mockResolvedValue({});
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
      { kind: 'owned', datalakeTag: 'datalake:lake-0', fileTagPrefix: 'stored0:', creatorUserId: 'creator-0' },
      { kind: 'owned', datalakeTag: 'datalake:lake-1', fileTagPrefix: 'stored1:', creatorUserId: 'creator-1' },
    ]);
  });

  it('scopes a lake IN THE REGISTRY as a registry lake, keeping its open prefix arm', async () => {
    // Registry-ness is positive evidence (STATIC_LAKE_IDS), never the absence of a document. The
    // registry scope is what stops this count from being meta-tag-only while the lake's own browse
    // matches the open prefix arm - the disagreement this whole change exists to remove.
    const registryLake = DATA_LAKES[0];
    h.findByDatalakeTags.mockResolvedValue([]);

    await queryDataLakeTagCounts(req, [registryLake as never]);

    expect(scopes()).toEqual([
      {
        kind: 'registry',
        datalakeTag: registryLake.datalakeTag,
        fileTagPrefix: registryLake.fileTagPrefix,
      },
    ]);
  });

  it('FAILS CLOSED for a doc-less lake that is not in the registry, rather than opening its prefix', async () => {
    // The guard that matters. `lake-0` is not a registry id, so it must not reach the registry arm
    // just because its document lookup came back empty - that arm drops the ownership conjunct,
    // and this lake's prefix is user-chosen. Meta-tag-only is what this branch produced before the
    // discriminated scope existed, so it is a no-op for real traffic and keeps the fail-closed
    // property. Emitting a scope at all (rather than skipping) keeps the lake's key in
    // lakeFileCounts, since the UI renders an absent count the same as zero.
    h.findByDatalakeTags.mockResolvedValue([]);

    await queryDataLakeTagCounts(req, [lake(0)]);

    expect(scopes()).toEqual([{ kind: 'owned', datalakeTag: 'datalake:lake-0' }]);
  });

  it('skips the lookup entirely when the caller can reach no lakes', async () => {
    await expect(queryDataLakeTagCounts(req, [])).resolves.toEqual({
      tagCounts: [],
      uniqueArticleCounts: { total: 0, byPrefix: {} },
      lakeFileCounts: {},
      lakeArmCounts: {},
    });
    expect(h.findByDatalakeTags).not.toHaveBeenCalled();
  });
});
