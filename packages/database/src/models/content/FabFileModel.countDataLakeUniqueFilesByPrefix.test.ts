import { describe, it, expect, vi } from 'vitest';
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

  // Archiving a lake stamps archivedAt on every file it holds, and the article list this number
  // labels filters those out. The route only ever passes non-archived lakes' prefixes, so this is
  // the aggregate holding the line on its own rather than trusting its caller.
  it('excludes archived files', async () => {
    await makeFile({ tags: ['acme:industry'], fileName: 'live' });
    await makeFile({ tags: ['acme:industry'], fileName: 'archived', archived: true });

    const { total, byPrefix } = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, ['acme:']);

    expect(total).toBe(1);
    expect(byPrefix).toEqual({ 'acme:': 1 });
  });

  it('returns zero for an empty prefix list (guards the match-everything regex)', async () => {
    await makeFile({ tags: ['acme:industry'] });

    const result = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, []);

    expect(result).toEqual({ total: 0, byPrefix: {} });
  });

  it('ignores a blank entry inside a non-empty prefix list', async () => {
    // A blank contributes an empty alternation, so `^(acme:|)` would match every tag and sweep
    // in the unrelated file below.
    await makeFile({ tags: ['acme:industry'] });
    await makeFile({ tags: ['personal-note'] });

    const result = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, ['acme:', '']);

    expect(result).toEqual({ total: 1, byPrefix: { 'acme:': 1 } });
  });

  it('never counts a membership meta-tag as content, even for a datalake:-prefixed lake', async () => {
    // Mirrors countDataLakeTagsByPrefix. Only legacy rows can have such a prefix (the create
    // schema rejects it now), but the two counters must not disagree about what is content.
    await makeFile({ tags: ['datalake:acme'] });

    const result = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, ['datalake:']);

    expect(result).toEqual({ total: 0, byPrefix: { 'datalake:': 0 } });
  });

  it('issues a bounded number of database operations for a large lake set', async () => {
    // The fan-out this batching exists to remove: `tagPrefixes` is one entry per lake the caller
    // can see, and on the admin tag-count path that is every lake of every tenant - one count per
    // prefix is thousands of round trips through a pool of two.
    const prefixes = Array.from({ length: 60 }, (_, i) => `lake${i}:`);
    // Two seeded lakes in different chunks: a facet key built from the wrong index would still
    // read chunk 0 correctly and silently zero every later chunk.
    await makeFile({ tags: ['lake7:alpha'], fileName: 'first-chunk' });
    await makeFile({ tags: ['lake52:beta'], fileName: 'third-chunk' });

    const countDocuments = vi.spyOn(FabFile, 'countDocuments');
    const aggregate = vi.spyOn(FabFile, 'aggregate');
    try {
      const { total, byPrefix } = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, prefixes);

      // One count for `total` plus ceil(60/25) chunk aggregates.
      expect(countDocuments.mock.calls.length + aggregate.mock.calls.length).toBeLessThanOrEqual(5);
      expect(total).toBe(2);
      expect(Object.keys(byPrefix)).toHaveLength(60);
      expect(byPrefix['lake7:']).toBe(1);
      expect(byPrefix['lake8:']).toBe(0);
      expect(byPrefix['lake52:']).toBe(1);
      expect(byPrefix['lake53:']).toBe(0);
    } finally {
      countDocuments.mockRestore();
      aggregate.mockRestore();
    }
  });

  it('keeps prefixes independent across a chunk boundary', async () => {
    // The multi-lake case above, but with the two lakes deliberately in different chunks: the
    // chunk union is per-chunk, so a file must still count under a prefix in each.
    const prefixes = Array.from({ length: 30 }, (_, i) => `lake${i}:`);
    await makeFile({ tags: ['lake1:x', 'lake26:y'], fileName: 'spans-chunks' });

    const { total, byPrefix } = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, prefixes);

    expect(total).toBe(1);
    expect(byPrefix['lake1:']).toBe(1);
    expect(byPrefix['lake26:']).toBe(1);
  });

  it('counts a padded prefix under its trimmed key', async () => {
    await makeFile({ tags: ['acme:industry'] });

    const result = await fabFileRepository.countDataLakeUniqueFilesByPrefix(USER, [' acme:']);

    expect(result).toEqual({ total: 1, byPrefix: { 'acme:': 1 } });
  });
});
