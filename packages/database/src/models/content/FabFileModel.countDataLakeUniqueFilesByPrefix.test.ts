import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const USER = 'user-1';

// Create a fab file directly on the model so the test can control tags,
// sessionId, and deletedAt (the repository's create() guards some of these).
const makeFile = (overrides: {
  userId?: string;
  tags?: string[];
  sessionId?: string | null;
  curatedNotebook?: boolean;
  deleted?: boolean;
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
  });
};

describe('FabFileRepository.countDataLakeUniqueFilesByPrefix', () => {
  setupMongoTest();

  it('counts a multi-lake file once in total but once per matching prefix', async () => {
    // One file tagged into BOTH lakes, one tagged into only acme.
    await makeFile({ tags: ['acme:industry', 'opti:family'], fileName: 'both' });
    await makeFile({ tags: ['acme:hardware'], fileName: 'acme-only' });

    const { total, byPrefix } = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, ['acme:', 'opti:']);

    // Two distinct files overall - the multi-lake file is NOT double-counted.
    expect(total).toBe(2);
    // ...but it IS counted under each lake's prefix.
    expect(byPrefix).toEqual({ 'acme:': 2, 'opti:': 1 });
  });

  it('excludes soft-deleted files (deletedAt filter applied)', async () => {
    await makeFile({ tags: ['acme:industry'], fileName: 'live' });
    await makeFile({ tags: ['acme:industry'], fileName: 'deleted', deleted: true });

    const { total, byPrefix } = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, ['acme:']);

    expect(total).toBe(1);
    expect(byPrefix).toEqual({ 'acme:': 1 });
  });

  it('applies the session filter: excludes session summaries unless curated-notebook', async () => {
    await makeFile({ tags: ['acme:industry'], fileName: 'no-session' }); // sessionId omitted → counted
    await makeFile({ tags: ['acme:industry'], fileName: 'session', sessionId: 'sess-1' }); // excluded
    await makeFile({ tags: ['acme:industry'], fileName: 'curated', sessionId: 'sess-2', curatedNotebook: true }); // counted

    const { total, byPrefix } = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, ['acme:']);

    expect(total).toBe(2);
    expect(byPrefix).toEqual({ 'acme:': 2 });
  });

  it('scopes counts to the requesting user', async () => {
    await makeFile({ userId: USER, tags: ['acme:industry'] });
    await makeFile({ userId: 'other-user', tags: ['acme:industry'] });

    const { total } = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, ['acme:']);

    expect(total).toBe(1);
  });

  it('returns zero for an empty prefix list (guards the match-everything regex)', async () => {
    await makeFile({ tags: ['acme:industry'] });

    const result = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, []);

    expect(result).toEqual({ total: 0, byPrefix: {} });
  });
});
