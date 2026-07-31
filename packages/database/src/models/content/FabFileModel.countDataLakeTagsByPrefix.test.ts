import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const USER = 'user-1';

// Create a fab file directly on the model so the test can control tags, sessionId, deletedAt and
// archivedAt (the repository's create() guards some of these). Mirrors the helper in the sibling
// countDataLakeUniqueFilesByPrefix test.
const makeFile = (overrides: {
  userId?: string;
  tags?: string[];
  sessionId?: string | null;
  curatedNotebook?: boolean;
  deleted?: boolean;
  archived?: boolean;
  fileName?: string;
}) => {
  const tagNames = [...(overrides.tags ?? [])];
  if (overrides.curatedNotebook) tagNames.push('curated-notebook');
  return FabFile.create({
    userId: overrides.userId ?? USER,
    fileName: overrides.fileName ?? 'doc',
    type: KnowledgeType.TEXT,
    tags: tagNames.map(name => ({ name })),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.deleted ? { deletedAt: new Date() } : {}),
    ...(overrides.archived ? { archivedAt: new Date() } : {}),
  });
};

const countOf = async (tag: string, prefixes: string[]) => {
  const counts = await fabFileRepository.countDataLakeTagsByPrefix(USER, prefixes);
  return counts.find(c => c.tag === tag)?.count ?? 0;
};

describe('FabFileRepository.countDataLakeTagsByPrefix', () => {
  setupMongoTest();

  it('counts each prefixed tag across the files that carry it', async () => {
    await makeFile({ tags: ['acme:industry', 'acme:hardware'], fileName: 'both' });
    await makeFile({ tags: ['acme:industry'], fileName: 'one' });

    expect(await countOf('acme:industry', ['acme:'])).toBe(2);
    expect(await countOf('acme:hardware', ['acme:'])).toBe(1);
  });

  it('ignores tags outside the requested prefixes', async () => {
    await makeFile({ tags: ['acme:industry', 'invoices'] });

    const counts = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:']);

    expect(counts.some(c => c.tag === 'invoices')).toBe(false);
  });

  // The tag tree these counts build sits beside an article list that filters archivedAt: null.
  // The route only passes non-archived lakes' prefixes, so this pins the aggregate's own guard.
  it('excludes archived files', async () => {
    await makeFile({ tags: ['acme:industry'], fileName: 'live' });
    await makeFile({ tags: ['acme:industry'], fileName: 'archived', archived: true });

    expect(await countOf('acme:industry', ['acme:'])).toBe(1);
  });

  it('excludes soft-deleted files', async () => {
    await makeFile({ tags: ['acme:industry'], fileName: 'live' });
    await makeFile({ tags: ['acme:industry'], fileName: 'deleted', deleted: true });

    expect(await countOf('acme:industry', ['acme:'])).toBe(1);
  });

  it('excludes session summaries unless they are curated notebooks', async () => {
    await makeFile({ tags: ['acme:industry'], fileName: 'session', sessionId: 'sess-1' });
    expect(await countOf('acme:industry', ['acme:'])).toBe(0);

    await makeFile({ tags: ['acme:industry'], fileName: 'curated', sessionId: 'sess-2', curatedNotebook: true });
    expect(await countOf('acme:industry', ['acme:'])).toBe(1);
  });

  it('scopes counts to the requesting user when no options widen it', async () => {
    await makeFile({ userId: 'other-user', tags: ['acme:industry'] });

    expect(await countOf('acme:industry', ['acme:'])).toBe(0);
  });

  // datalake: meta-tags are membership markers, not content tags, so the tree must not list them.
  it('omits the datalake meta-tag from the tree', async () => {
    await makeFile({ tags: ['datalake:acme:handbook', 'acme:industry'] });

    const counts = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:', 'datalake:']);

    expect(counts.some(c => c.tag === 'datalake:acme:handbook')).toBe(false);
    expect(counts.some(c => c.tag === 'acme:industry')).toBe(true);
  });
});
