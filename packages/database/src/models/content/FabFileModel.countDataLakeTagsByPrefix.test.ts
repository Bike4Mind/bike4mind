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
  users?: { userId: string; permissions: string[] }[];
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
    ...(overrides.users ? { users: overrides.users } : {}),
  });
};

const countOf = async (
  tag: string,
  prefixes: string[],
  options?: Parameters<typeof fabFileRepository.countDataLakeTagsByPrefix>[2]
) => {
  const counts = await fabFileRepository.countDataLakeTagsByPrefix(USER, prefixes, options);
  return counts.find(c => c.tag === tag)?.count ?? 0;
};

// One file tagged `acme:uncategorized`: its own row plus the `acme` ancestor row the tree branches on.
const UNCATEGORIZED_ONE = [
  { tag: 'acme', count: 0, fileCount: 1 },
  { tag: 'acme:uncategorized', count: 1, fileCount: 1 },
];

const sortedByTag = <T extends { tag: string }>(rows: T[]) => [...rows].sort((a, b) => a.tag.localeCompare(b.tag));

describe('FabFileRepository.countDataLakeTagsByPrefix', () => {
  setupMongoTest();

  it('counts each prefixed tag across the files that carry it', async () => {
    await makeFile({ tags: ['acme:industry', 'acme:hardware'], fileName: 'both' });
    await makeFile({ tags: ['acme:industry'], fileName: 'one' });

    expect(await countOf('acme:industry', ['acme:'])).toBe(2);
    expect(await countOf('acme:hardware', ['acme:'])).toBe(1);
  });

  describe('distinct files per tree path', () => {
    const rowOf = async (tag: string) =>
      (await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'])).find(c => c.tag === tag);

    // The tree's branch rows read fileCount; summing per-tag counts here gave 12.
    it('counts a branch over multi-tagged files once per file, not once per tag', async () => {
      const leaves = ['acme:legal:a', 'acme:legal:b', 'acme:legal:c', 'acme:legal:d'];
      for (const fileName of ['f1', 'f2', 'f3']) await makeFile({ tags: leaves, fileName });

      expect(await rowOf('acme:legal')).toEqual({ tag: 'acme:legal', count: 0, fileCount: 3 });
      expect(await rowOf('acme')).toEqual({ tag: 'acme', count: 0, fileCount: 3 });
      for (const leaf of leaves) expect(await rowOf(leaf)).toEqual({ tag: leaf, count: 3, fileCount: 3 });
    });

    it('still adds up a branch whose leaves hold disjoint files', async () => {
      await makeFile({ tags: ['acme:legal:a'], fileName: 'a' });
      await makeFile({ tags: ['acme:legal:b'], fileName: 'b' });
      await makeFile({ tags: ['acme:legal:a', 'acme:legal:b'], fileName: 'ab' });

      expect(await rowOf('acme:legal')).toEqual({ tag: 'acme:legal', count: 0, fileCount: 3 });
      expect(await rowOf('acme:legal:a')).toEqual({ tag: 'acme:legal:a', count: 2, fileCount: 2 });
    });

    it('counts a branch tagged directly as its own files and its descendants together', async () => {
      await makeFile({ tags: ['acme:legal', 'acme:legal:a'], fileName: 'both' });
      await makeFile({ tags: ['acme:legal'], fileName: 'branch-only' });

      expect(await rowOf('acme:legal')).toEqual({ tag: 'acme:legal', count: 2, fileCount: 2 });
      expect(await rowOf('acme:legal:a')).toEqual({ tag: 'acme:legal:a', count: 1, fileCount: 1 });
    });

    it('counts a tag repeated on one file once', async () => {
      await makeFile({ tags: ['acme:legal:a', 'acme:legal:a'] });

      expect(await rowOf('acme:legal:a')).toEqual({ tag: 'acme:legal:a', count: 1, fileCount: 1 });
    });

    it('keeps the meta-tag and out-of-prefix tags out of the ancestor rows', async () => {
      await makeFile({ tags: ['datalake:acme:handbook', 'invoices:2024', 'acme:legal'] });

      const counts = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:', 'datalake:']);

      expect(sortedByTag(counts).map(c => c.tag)).toEqual(['acme', 'acme:legal']);
    });
  });

  it('ignores tags outside the requested prefixes', async () => {
    await makeFile({ tags: ['acme:industry', 'invoices'] });

    const counts = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:']);

    expect(counts.some(c => c.tag === 'invoices')).toBe(false);
  });

  it('returns nothing for a file carrying only the datalake meta-tag with no prefixed tag', async () => {
    await makeFile({ tags: ['datalake:orga:acme'] });

    expect(await countOf('acme:uncategorized', ['acme:'])).toBe(0);
  });

  // datalake: meta-tags are membership markers, not content tags, so the tree must not list them.
  it('omits the datalake meta-tag from the tree even when a requested prefix would match it', async () => {
    await makeFile({ tags: ['datalake:acme:handbook', 'acme:industry'] });

    const counts = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:', 'datalake:']);

    expect(counts.some(c => c.tag === 'datalake:acme:handbook')).toBe(false);
    expect(counts.some(c => c.tag === 'acme:industry')).toBe(true);
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

  describe('ownership scoping', () => {
    it('excludes another user file carrying a lake prefix this caller has no arm for', async () => {
      await makeFile({ userId: 'other-user', tags: ['acme:uncategorized'] });

      // No lake arm at all: the file is reachable only through base access, which this caller
      // does not have on it. The prefix alone was never a grant.
      const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], {});

      expect(result).toEqual([]);
    });

    it('includes another user file via the exact data-lake meta-tag arm', async () => {
      await makeFile({ userId: 'other-user', tags: ['datalake:orga:acme', 'acme:uncategorized'] });

      const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], {
        dataLakeTags: ['datalake:orga:acme'],
      });

      expect(sortedByTag(result)).toEqual(UNCATEGORIZED_ONE);
    });

    it('includes a file shared with our user through the plain base-access arm', async () => {
      await makeFile({
        userId: 'other-user',
        tags: ['acme:uncategorized'],
        users: [{ userId: USER, permissions: ['read'] }],
      });

      const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], {});

      expect(sortedByTag(result)).toEqual(UNCATEGORIZED_ONE);
    });
  });

  describe('creator-anchored lakeMemberships', () => {
    const scope = {
      kind: 'owned' as const,
      datalakeTag: 'datalake:orga:acme',
      fileTagPrefix: 'acme:',
      creatorUserId: 'creator-1',
    };

    it('counts a creator-owned prefix-only member for a non-creator viewer only when the scope is passed', async () => {
      await makeFile({ userId: 'creator-1', tags: ['acme:uncategorized'] });

      expect(await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], {})).toEqual([]);
      const scoped = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], { lakeMemberships: [scope] });
      expect(sortedByTag(scoped)).toEqual(UNCATEGORIZED_ONE);
    });

    it("does not count a different creator's file carrying the same prefix", async () => {
      await makeFile({ userId: 'someone-else', tags: ['acme:uncategorized'] });

      const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], { lakeMemberships: [scope] });

      expect(result).toEqual([]);
    });
  });

  it('returns nothing for an empty prefix list', async () => {
    await makeFile({ tags: ['acme:uncategorized'] });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, []);

    expect(result).toEqual([]);
  });

  it('does not let a blank entry in a non-empty prefix list match every tag', async () => {
    // Without the usableTagPrefixes guard, `['acme:', '']` becomes the regex `^(acme:|)`,
    // which matches any tag name - including the unrelated one below.
    await makeFile({ tags: ['acme:uncategorized', 'personal-note'] });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:', '']);

    expect(sortedByTag(result)).toEqual(UNCATEGORIZED_ONE);
  });

  it("ignores a colon-less prefix, which would reach another lake's namespace", async () => {
    // `acme` without its colon anchors to `^acme` and would sweep in `acmecorp:` tags - a
    // different lake's content. usableTagPrefixes applies normalizeTagPrefix's rule, so it drops.
    await makeFile({ tags: ['acmecorp:secret'] });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme']);

    expect(result).toEqual([]);
  });

  it('counts a padded prefix, which builds no usable regex untrimmed', async () => {
    // Both counters share usableTagPrefixes; the sibling suite pins this too, so a future edit
    // dropping the trim is caught on either side rather than only one.
    await makeFile({ tags: ['acme:uncategorized'] });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, [' acme:']);

    expect(sortedByTag(result)).toEqual(UNCATEGORIZED_ONE);
  });
});
