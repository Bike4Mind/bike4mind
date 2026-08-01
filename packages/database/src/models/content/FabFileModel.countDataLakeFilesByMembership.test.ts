import { describe, it, expect } from 'vitest';
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
}) =>
  FabFile.create({
    userId: overrides.userId ?? CREATOR,
    fileName: overrides.fileName ?? 'doc',
    type: KnowledgeType.TEXT,
    tags: (overrides.tags ?? []).map(name => ({ name })),
    ...(overrides.deleted ? { deletedAt: new Date() } : {}),
    ...(overrides.archived ? { archivedAt: new Date() } : {}),
  });

const scope = (slug: string, prefix = '', creator: string | undefined = CREATOR) => ({
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

  it('returns an empty map when asked for no lakes', async () => {
    await expect(fabFileRepository.countDataLakeFilesByMembership([])).resolves.toEqual({});
  });
});
