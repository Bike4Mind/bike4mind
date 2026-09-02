import { describe, it, expect, vi } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const CREATOR = 'creator-1';
const OTHER = 'other-1';

const makeFile = (overrides: {
  userId?: string;
  tags?: string[];
  fileName?: string;
  deleted?: boolean;
  archived?: boolean;
  pending?: boolean;
}) =>
  FabFile.create({
    userId: overrides.userId ?? CREATOR,
    fileName: overrides.fileName ?? 'doc',
    type: KnowledgeType.TEXT,
    tags: (overrides.tags ?? []).map(name => ({ name })),
    // A real member file has always finished uploading by the time anything counts it; the
    // schema default is 'pending', which is the not-yet-landed state these counts must exclude.
    status: overrides.pending ? 'pending' : 'complete',
    ...(overrides.deleted ? { deletedAt: new Date() } : {}),
    ...(overrides.archived ? { archivedAt: new Date() } : {}),
  });

const scope = (slug: string, prefix = '', creator: string = CREATOR) => ({
  datalakeTag: `datalake:${slug}`,
  fileTagPrefix: prefix,
  creatorUserId: creator,
});

/** The `total` half of each lake's breakdown, for the assertions that only pin membership. The
 *  `uncategorized` half has its own describe block below. */
const totals = (counts: Record<string, { total: number }>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).map(([tag, c]) => [tag, c.total]));

describe('FabFileRepository.countDataLakeFilesByMembership', () => {
  setupMongoTest();

  it('counts a file that carries only the membership tag', async () => {
    // The shape the upload wizard and bulk ingest produce: meta-tag, no taxonomy tags.
    await makeFile({ tags: ['datalake:papers'], fileName: 'a' });
    await makeFile({ tags: ['datalake:papers'], fileName: 'b' });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

    expect(totals(counts)).toEqual({ 'datalake:papers': 2 });
  });

  it('counts each file once even when it carries several taxonomy tags', async () => {
    // The tag-occurrence bug: this file would count as 3, not 1.
    await makeFile({ tags: ['datalake:books', 'books:business', 'books:power', 'books:media'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('books', 'books:')]);

    expect(totals(counts)).toEqual({ 'datalake:books': 1 });
  });

  it('counts a prefix-tagged file the creator owns, matching the membership predicate', async () => {
    await makeFile({ tags: ['books:business'], fileName: 'prefix-only' });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('books', 'books:')]);

    expect(totals(counts)).toEqual({ 'datalake:books': 1 });
  });

  it('ignores a prefix-tagged file owned by someone else', async () => {
    await makeFile({ tags: ['books:business'], userId: OTHER, fileName: 'theirs' });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('books', 'books:')]);

    expect(totals(counts)).toEqual({ 'datalake:books': 0 });
  });

  it('excludes soft-deleted and archived files, matching computeDataLakeStats', async () => {
    await makeFile({ tags: ['datalake:papers'], fileName: 'live' });
    await makeFile({ tags: ['datalake:papers'], fileName: 'gone', deleted: true });
    await makeFile({ tags: ['datalake:papers'], fileName: 'shelved', archived: true });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

    expect(totals(counts)).toEqual({ 'datalake:papers': 1 });
  });

  it('excludes a presigned file whose bytes have not landed yet', async () => {
    // A presign door stamps the lake's meta-tag before the browser sends a byte. Counting this
    // row would let an abandoned upload permanently activate an otherwise-empty lake (#1342).
    await makeFile({ tags: ['datalake:papers'], fileName: 'still-uploading', pending: true });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

    expect(totals(counts)).toEqual({ 'datalake:papers': 0 });
  });

  it('returns a count per requested lake, keyed by membership tag', async () => {
    await makeFile({ tags: ['datalake:papers'] });
    await makeFile({ tags: ['datalake:books', 'books:business'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([
      scope('papers', 'papers:'),
      scope('books', 'books:'),
      scope('empty', 'empty:'),
    ]);

    expect(totals(counts)).toEqual({ 'datalake:papers': 1, 'datalake:books': 1, 'datalake:empty': 0 });
  });

  it('counts a file that belongs to two lakes once for EACH of them', async () => {
    // `addFileToLake` has no exclusivity check, so one file can carry two lakes' meta-tags. The
    // counts are per-scope independent: batching them into one query must not make this file
    // land on a single lake.
    await makeFile({ tags: ['datalake:papers', 'datalake:books'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([
      scope('papers', 'papers:'),
      scope('books', 'books:'),
    ]);

    expect(totals(counts)).toEqual({ 'datalake:papers': 1, 'datalake:books': 1 });
  });

  it('falls back to meta-tag-only matching for a scope with no creator', async () => {
    // A static-registry lake has no document and so no `createdByUserId`; the prefix arm has
    // nothing to anchor to and must drop out rather than match every `books:` file.
    await makeFile({ tags: ['datalake:books'], fileName: 'meta' });
    await makeFile({ tags: ['books:business'], fileName: 'prefix-only' });

    // Built inline, not through `scope`: a default parameter would put the creator back.
    const counts = await fabFileRepository.countDataLakeFilesByMembership([
      { datalakeTag: 'datalake:books', fileTagPrefix: 'books:', creatorUserId: undefined },
    ]);

    expect(totals(counts)).toEqual({ 'datalake:books': 1 });
  });

  it('issues a bounded number of database operations for a large lake set', async () => {
    // The fan-out this batching exists to remove: an admin's lake set is every lake of every
    // tenant, and one count per lake is thousands of round trips through a pool of two. The
    // bound is what matters here, not the exact chunk size.
    const scopes = Array.from({ length: 60 }, (_, i) => scope(`lake-${i}`, `lake${i}:`));
    // Two seeded lakes, deliberately in different chunks: a facet key built from the wrong
    // index would still read chunk 0 correctly and silently zero every later chunk.
    await makeFile({ tags: ['datalake:lake-7'] });
    await makeFile({ tags: ['datalake:lake-52'] });

    const countDocuments = vi.spyOn(FabFile, 'countDocuments');
    const aggregate = vi.spyOn(FabFile, 'aggregate');
    try {
      const counts = await fabFileRepository.countDataLakeFilesByMembership(scopes);

      expect(countDocuments.mock.calls.length + aggregate.mock.calls.length).toBeLessThanOrEqual(5);
      expect(Object.keys(counts)).toHaveLength(60);
      expect(counts['datalake:lake-7'].total).toBe(1);
      expect(counts['datalake:lake-8'].total).toBe(0);
      expect(counts['datalake:lake-52'].total).toBe(1);
      expect(counts['datalake:lake-53'].total).toBe(0);
    } finally {
      countDocuments.mockRestore();
      aggregate.mockRestore();
    }
  });

  describe('uncategorized slice', () => {
    // The bucket a prefix-keyed tag tree renders for the members it has no branch for. It rides
    // the same aggregate as `total` so a browse surface can subtract one from the other and get
    // exactly what its branches cover (#2031).

    it('counts a meta-tag-only member as uncategorized', async () => {
      // What the upload wizard produces, and the file the picker counted but the tree could not
      // show: in the lake, under no category.
      await makeFile({ tags: ['datalake:papers'] });

      const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

      expect(counts['datalake:papers']).toEqual({ total: 1, uncategorized: 1 });
    });

    it('does not count a member carrying a tag under the prefix', async () => {
      await makeFile({ tags: ['datalake:papers', 'papers:physics'] });

      const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

      expect(counts['datalake:papers']).toEqual({ total: 1, uncategorized: 0 });
    });

    it('counts the server-stamped `<prefix>uncategorized` placeholder as CATEGORIZED', async () => {
      // The fallback tagger stamps a real `papers:uncategorized` tag, which the tree renders as
      // an ordinary folder. Counting it here too would double-report it - once in the bucket and
      // once in that folder - so the bucket is strictly the files with no prefix tag at all.
      await makeFile({ tags: ['datalake:papers', 'papers:uncategorized'] });

      const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

      expect(counts['datalake:papers']).toEqual({ total: 1, uncategorized: 0 });
    });

    it('treats a bare `papers:` tag as uncategorized, matching satisfiesTagPrefix', async () => {
      // A suffix-less prefix renders as an unlabeled tree row, so it is not a category anyone can
      // navigate to. The shared uncategorized rule says so; this must agree with it.
      await makeFile({ tags: ['datalake:papers', 'papers:'] });

      const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

      expect(counts['datalake:papers']).toEqual({ total: 1, uncategorized: 1 });
    });

    it('never exceeds the lake total, and excludes the same non-live rows', async () => {
      await makeFile({ tags: ['datalake:papers'], fileName: 'live-uncategorized' });
      await makeFile({ tags: ['datalake:papers', 'papers:physics'], fileName: 'live-categorized' });
      await makeFile({ tags: ['datalake:papers'], fileName: 'gone', deleted: true });
      await makeFile({ tags: ['datalake:papers'], fileName: 'shelved', archived: true });
      await makeFile({ tags: ['datalake:papers'], fileName: 'uploading', pending: true });

      const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

      expect(counts['datalake:papers']).toEqual({ total: 2, uncategorized: 1 });
    });

    it('reports 0 for a lake with no usable prefix rather than its whole membership', async () => {
      // With no prefix there is no taxonomy to be outside of, and the tree renders no branches
      // for such a lake either - so "every member is uncategorized" would be a bucket standing in
      // for the entire lake.
      await makeFile({ tags: ['datalake:papers'] });

      const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', '')]);

      expect(counts['datalake:papers']).toEqual({ total: 1, uncategorized: 0 });
    });

    it('judges each lake against its OWN prefix when one file belongs to two', async () => {
      // Categorized in books, uncategorized in papers - the per-scope independence the facet
      // branches exist for, now on both halves of the breakdown.
      await makeFile({ tags: ['datalake:papers', 'datalake:books', 'books:business'] });

      const counts = await fabFileRepository.countDataLakeFilesByMembership([
        scope('papers', 'papers:'),
        scope('books', 'books:'),
      ]);

      expect(counts).toEqual({
        'datalake:papers': { total: 1, uncategorized: 1 },
        'datalake:books': { total: 1, uncategorized: 0 },
      });
    });
  });

  it('returns an empty map when asked for no lakes', async () => {
    await expect(fabFileRepository.countDataLakeFilesByMembership([])).resolves.toEqual({});
  });
});

describe('FabFileRepository.countDistinctDataLakeFilesByMembership', () => {
  setupMongoTest();

  it('counts a file in two lakes ONCE, unlike the per-lake counts', async () => {
    // The whole point: the per-lake rows sum to 2 for this file, and an all-lakes number sitting
    // above those rows must not repeat it.
    await makeFile({ tags: ['datalake:papers', 'datalake:books'] });

    const scopes = [scope('papers', 'papers:'), scope('books', 'books:')];
    const perLake = await fabFileRepository.countDataLakeFilesByMembership(scopes);

    expect(totals(perLake)).toEqual({ 'datalake:papers': 1, 'datalake:books': 1 });
    await expect(fabFileRepository.countDistinctDataLakeFilesByMembership(scopes)).resolves.toBe(1);
  });

  it('counts a meta-tag-only member, which the prefix-based total misses entirely', async () => {
    // The reason this replaced `uniqueArticleCounts.total` on the all-lakes row: a lake whose
    // files carry only the meta-tag contributes nothing to a prefix-keyed total, so the all-lakes
    // number could read LOWER than a single per-lake row beneath it (#2031).
    await makeFile({ tags: ['datalake:papers'], fileName: 'a' });
    await makeFile({ tags: ['datalake:papers'], fileName: 'b' });

    await expect(fabFileRepository.countDistinctDataLakeFilesByMembership([scope('papers', 'papers:')])).resolves.toBe(
      2
    );
  });

  it('excludes deleted, archived and still-uploading rows, matching the per-lake counts', async () => {
    await makeFile({ tags: ['datalake:papers'], fileName: 'live' });
    await makeFile({ tags: ['datalake:papers'], fileName: 'gone', deleted: true });
    await makeFile({ tags: ['datalake:papers'], fileName: 'shelved', archived: true });
    await makeFile({ tags: ['datalake:papers'], fileName: 'uploading', pending: true });

    await expect(fabFileRepository.countDistinctDataLakeFilesByMembership([scope('papers', 'papers:')])).resolves.toBe(
      1
    );
  });

  it('ignores a prefix-tagged file owned by someone else, as the membership predicate does', async () => {
    await makeFile({ tags: ['papers:physics'], userId: OTHER });

    await expect(fabFileRepository.countDistinctDataLakeFilesByMembership([scope('papers', 'papers:')])).resolves.toBe(
      0
    );
  });

  it('returns 0 when asked for no lakes', async () => {
    await expect(fabFileRepository.countDistinctDataLakeFilesByMembership([])).resolves.toBe(0);
  });
});

describe('FabFileRepository.countDistinctUncategorizedDataLakeFilesByMembership', () => {
  setupMongoTest();

  const bothLakes = () => [scope('papers', 'papers:'), scope('books', 'books:')];
  const bothPrefixes = ['papers:', 'books:'];

  it('excludes a file categorized in ONE lake, which the merged tree already shows', async () => {
    // The reason this is not a sum of the per-lake `uncategorized` figures: loose in papers, filed
    // under books:business - so the merged tree reaches it under that branch and the all-lakes
    // bucket must not offer it a second time.
    await makeFile({ tags: ['datalake:papers', 'datalake:books', 'books:business'] });

    const perLake = await fabFileRepository.countDataLakeFilesByMembership(bothLakes());
    expect(perLake['datalake:papers'].uncategorized).toBe(1);

    await expect(
      fabFileRepository.countDistinctUncategorizedDataLakeFilesByMembership(bothLakes(), bothPrefixes)
    ).resolves.toBe(0);
  });

  it('counts a file loose in TWO lakes once, where summing the per-lake figures counts it twice', async () => {
    await makeFile({ tags: ['datalake:papers', 'datalake:books'] });

    const perLake = await fabFileRepository.countDataLakeFilesByMembership(bothLakes());
    expect(perLake['datalake:papers'].uncategorized + perLake['datalake:books'].uncategorized).toBe(2);

    await expect(
      fabFileRepository.countDistinctUncategorizedDataLakeFilesByMembership(bothLakes(), bothPrefixes)
    ).resolves.toBe(1);
  });

  it('counts a member categorized under no accessible prefix at all', async () => {
    await makeFile({ tags: ['datalake:papers', 'unrelated:thing'] });

    await expect(
      fabFileRepository.countDistinctUncategorizedDataLakeFilesByMembership(bothLakes(), bothPrefixes)
    ).resolves.toBe(1);
  });

  it('excludes deleted, archived and still-uploading rows, matching the counts it sits beside', async () => {
    await makeFile({ tags: ['datalake:papers'], fileName: 'live' });
    await makeFile({ tags: ['datalake:papers'], fileName: 'gone', deleted: true });
    await makeFile({ tags: ['datalake:papers'], fileName: 'shelved', archived: true });
    await makeFile({ tags: ['datalake:papers'], fileName: 'uploading', pending: true });

    await expect(
      fabFileRepository.countDistinctUncategorizedDataLakeFilesByMembership(bothLakes(), bothPrefixes)
    ).resolves.toBe(1);
  });

  it('falls back to the whole membership when no prefix is usable, rather than to zero', async () => {
    // With no prefixes there is no taxonomy for the merged tree to render, so every member is
    // unreachable through a branch - the bucket is the whole lake, not nothing.
    await makeFile({ tags: ['datalake:papers'] });

    await expect(
      fabFileRepository.countDistinctUncategorizedDataLakeFilesByMembership(bothLakes(), ['', 'nope'])
    ).resolves.toBe(1);
  });

  it('returns 0 when asked for no lakes', async () => {
    await expect(fabFileRepository.countDistinctUncategorizedDataLakeFilesByMembership([], bothPrefixes)).resolves.toBe(
      0
    );
  });
});
