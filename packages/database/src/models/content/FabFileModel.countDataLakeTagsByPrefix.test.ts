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
    ...(overrides.users ? { users: overrides.users } : {}),
  });
};

describe('FabFileRepository.countDataLakeTagsByPrefix', () => {
  setupMongoTest();

  it('counts a tag matching the requested prefix', async () => {
    await makeFile({ tags: ['acme:uncategorized'] });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:']);

    expect(result).toEqual([{ tag: 'acme:uncategorized', count: 1 }]);
  });

  it('returns nothing for a file carrying only the datalake meta-tag with no prefixed tag', async () => {
    await makeFile({ tags: ['datalake:orga:acme'] });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:']);

    expect(result).toEqual([]);
  });

  it('excludes the datalake meta-tag even when a requested prefix would match it', async () => {
    // Both tags match `['datalake:', 'acme:']`, but the meta-tag itself must never
    // appear in the tag-tree output - only the real category tag should.
    await makeFile({ tags: ['datalake:orga:acme', 'acme:uncategorized'] });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['datalake:', 'acme:']);

    expect(result).toEqual([{ tag: 'acme:uncategorized', count: 1 }]);
  });

  describe('ownership scoping', () => {
    it('excludes another user file from the scoped-prefix arm', async () => {
      await makeFile({ userId: 'other-user', tags: ['acme:uncategorized'] });

      const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], {
        scopedTagPrefixes: ['acme:'],
      });

      expect(result).toEqual([]);
    });

    it('includes another user file via the exact data-lake meta-tag arm', async () => {
      await makeFile({ userId: 'other-user', tags: ['datalake:orga:acme', 'acme:uncategorized'] });

      const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], {
        dataLakeTags: ['datalake:orga:acme'],
      });

      expect(result).toEqual([{ tag: 'acme:uncategorized', count: 1 }]);
    });

    it('includes a file shared with our user via the scoped-prefix arm (base access AND)', async () => {
      await makeFile({
        userId: 'other-user',
        tags: ['acme:uncategorized'],
        users: [{ userId: USER, permissions: ['read'] }],
      });

      const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:'], {
        scopedTagPrefixes: ['acme:'],
      });

      expect(result).toEqual([{ tag: 'acme:uncategorized', count: 1 }]);
    });
  });

  it('excludes soft-deleted files', async () => {
    await makeFile({ tags: ['acme:uncategorized'], deleted: true });

    const result = await fabFileRepository.countDataLakeTagsByPrefix(USER, ['acme:']);

    expect(result).toEqual([]);
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

    expect(result).toEqual([{ tag: 'acme:uncategorized', count: 1 }]);
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

    expect(result).toEqual([{ tag: 'acme:uncategorized', count: 1 }]);
  });
});
