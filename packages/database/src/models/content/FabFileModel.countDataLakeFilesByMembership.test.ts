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

describe('FabFileRepository.countDataLakeFilesByMembership', () => {
  setupMongoTest();

  it('counts a file that carries only the membership tag', async () => {
    // The shape the upload wizard and bulk ingest produce: meta-tag, no taxonomy tags.
    await makeFile({ tags: ['datalake:papers'], fileName: 'a' });
    await makeFile({ tags: ['datalake:papers'], fileName: 'b' });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': 2 });
  });

  it('counts each file once even when it carries several taxonomy tags', async () => {
    // The tag-occurrence bug: this file would count as 3, not 1.
    await makeFile({ tags: ['datalake:books', 'books:business', 'books:power', 'books:media'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('books', 'books:')]);

    expect(counts).toEqual({ 'datalake:books': 1 });
  });

  it('counts a prefix-tagged file the creator owns, matching the membership predicate', async () => {
    await makeFile({ tags: ['books:business'], fileName: 'prefix-only' });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('books', 'books:')]);

    expect(counts).toEqual({ 'datalake:books': 1 });
  });

  it('ignores a prefix-tagged file owned by someone else', async () => {
    await makeFile({ tags: ['books:business'], userId: OTHER, fileName: 'theirs' });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('books', 'books:')]);

    expect(counts).toEqual({ 'datalake:books': 0 });
  });

  it('excludes soft-deleted and archived files, matching computeDataLakeStats', async () => {
    await makeFile({ tags: ['datalake:papers'], fileName: 'live' });
    await makeFile({ tags: ['datalake:papers'], fileName: 'gone', deleted: true });
    await makeFile({ tags: ['datalake:papers'], fileName: 'shelved', archived: true });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': 1 });
  });

  it('excludes a presigned file whose bytes have not landed yet', async () => {
    // A presign door stamps the lake's meta-tag before the browser sends a byte. Counting this
    // row would let an abandoned upload permanently activate an otherwise-empty lake (#1342).
    await makeFile({ tags: ['datalake:papers'], fileName: 'still-uploading', pending: true });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': 0 });
  });

  it('returns a count per requested lake, keyed by membership tag', async () => {
    await makeFile({ tags: ['datalake:papers'] });
    await makeFile({ tags: ['datalake:books', 'books:business'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembership([
      scope('papers', 'papers:'),
      scope('books', 'books:'),
      scope('empty', 'empty:'),
    ]);

    expect(counts).toEqual({ 'datalake:papers': 1, 'datalake:books': 1, 'datalake:empty': 0 });
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

    expect(counts).toEqual({ 'datalake:papers': 1, 'datalake:books': 1 });
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

    expect(counts).toEqual({ 'datalake:books': 1 });
  });

  it('issues a bounded number of database operations for a large lake set', async () => {
    // The fan-out this batching exists to remove: an admin's lake set is every lake of every
    // tenant, and one count per lake is thousands of round trips through a pool of two. The
    // bound is what matters here, not the exact chunk size.
    const scopes = Array.from({ length: 60 }, (_, i) => scope(`lake-${i}`, `lake${i}:`));
    await makeFile({ tags: ['datalake:lake-7'] });

    const countDocuments = vi.spyOn(FabFile, 'countDocuments');
    const aggregate = vi.spyOn(FabFile, 'aggregate');
    try {
      const counts = await fabFileRepository.countDataLakeFilesByMembership(scopes);

      expect(countDocuments.mock.calls.length + aggregate.mock.calls.length).toBeLessThanOrEqual(5);
      expect(Object.keys(counts)).toHaveLength(60);
      expect(counts['datalake:lake-7']).toBe(1);
      expect(counts['datalake:lake-8']).toBe(0);
    } finally {
      countDocuments.mockRestore();
      aggregate.mockRestore();
    }
  });

  it('returns an empty map when asked for no lakes', async () => {
    await expect(fabFileRepository.countDataLakeFilesByMembership([])).resolves.toEqual({});
  });
});
