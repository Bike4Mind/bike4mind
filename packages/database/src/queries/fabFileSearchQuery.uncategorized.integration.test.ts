import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, type DataLakeMembershipScope } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';

/**
 * `lacksContentPrefixTags` is what serves an "Uncategorized" bucket: the lake members carrying no
 * tag under any of the given prefixes, which a prefix-keyed browse tree has no branch for. One
 * prefix is a single lake's bucket; the whole accessible set is the merged tree's.
 *
 * Run against a real server rather than asserted structurally because the failure mode is a
 * SILENT one: the uncategorized fragment's top-level key is `tags`, the membership prefix arm's
 * is `tags` too, and an object spread would drop one of them with no type error and no runtime
 * error - the query would just widen to every file the caller can see. Only executing it shows
 * that the two are ANDed.
 *
 * `buildLacksContentPrefixTagFilter`'s agreement with `satisfiesTagPrefix` is pinned separately
 * in dataLakeLifecycleScope.integration.test.ts; this covers the wiring, not the rule.
 */

const CREATOR = 'creator-1';
const OUTSIDER = 'outsider-1';

const scope: DataLakeMembershipScope = {
  kind: 'owned',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  creatorUserId: CREATOR,
};

const browse = async (options: { lacksContentPrefixTags?: string[] } = {}) => {
  const result = await fabFileRepository.search(
    CREATOR,
    '',
    { shared: false },
    { page: 1, limit: 50 },
    { by: 'fileName', direction: 'asc' },
    {
      includeShared: true,
      restrictToDataLake: true,
      lakeMemberships: [scope],
      excludeContent: true,
      ...options,
    }
  );
  return result.data.map(f => f.fileName).sort();
};

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await FabFile.create(
    [
      // Member via the meta-tag, no taxonomy tag - the file the picker counted while the tree
      // could not show it. Arises where the fallback tagger does not stamp
      // `<prefix>uncategorized`: a STATIC registry lake (no lake document to resolve a prefix
      // from), either decideStampPrefix decline, or a row predating that tagger.
      { fileName: 'meta-only', tags: ['datalake:acme'] },
      // Member via the meta-tag AND categorized - the tree has a branch for this one.
      { fileName: 'categorized', tags: ['datalake:acme', 'acme:legal'] },
      // The server-stamped placeholder is a REAL tag and renders as an ordinary folder, so it is
      // categorized as far as the bucket is concerned - counting it both places would double-report.
      { fileName: 'placeholder', tags: ['datalake:acme', 'acme:uncategorized'] },
      // Member via the prefix arm alone (creator-owned), so already categorized.
      { fileName: 'prefix-only', tags: ['acme:finance'] },
      // Meta-tagged but carrying only OTHER namespaces' tags - uncategorized under this prefix.
      { fileName: 'foreign-tags', tags: ['datalake:acme', 'globex:legal', 'important'] },
      // NOT a member: the prefix arm is anchored to the creator, so this must stay out of both the
      // full list and the bucket. If the bucket ever widens past the membership arm, this appears.
      { fileName: 'outsider-uncategorized', userId: OUTSIDER, tags: ['datalake:other'] },
      // The creator's own file, in no lake at all - what `restrictToDataLake` exists to exclude.
      { fileName: 'not-in-any-lake', tags: ['personal'] },
    ].map(f => ({
      userId: f.userId ?? CREATOR,
      fileName: f.fileName,
      type: KnowledgeType.FILE,
      tags: f.tags.map(name => ({ name, strength: 1 })),
    }))
  );
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

describe('buildFabFileSearchQuery lacksContentPrefixTags', () => {
  it('narrows the lake browse to the members carrying no tag under its prefix', async () => {
    await expect(browse({ lacksContentPrefixTags: ['acme:'] })).resolves.toEqual(['foreign-tags', 'meta-only']);
  });

  it('stays INSIDE the lake - it narrows the membership arm rather than replacing it', async () => {
    // The spread hazard: were the uncategorized fragment to clobber the membership arm, these two
    // would appear (an uncategorized file in someone else's lake, and one in no lake at all).
    const bucket = await browse({ lacksContentPrefixTags: ['acme:'] });

    expect(bucket).not.toContain('outsider-uncategorized');
    expect(bucket).not.toContain('not-in-any-lake');
  });

  it('partitions the lake exactly: bucket + categorized = the whole membership', async () => {
    // The property the picker's count depends on. Whatever the tree's branches cover, the bucket
    // is the rest - so a surface can show one number above both and account for every file.
    const all = await browse();
    const bucket = await browse({ lacksContentPrefixTags: ['acme:'] });

    expect(all).toEqual(['categorized', 'foreign-tags', 'meta-only', 'placeholder', 'prefix-only']);
    expect(all.filter(name => !bucket.includes(name))).toEqual(['categorized', 'placeholder', 'prefix-only']);
  });

  it('is a byte-identical no-op when unset', async () => {
    await expect(browse()).resolves.toEqual(await browse({ lacksContentPrefixTags: undefined }));
  });

  it('ANDs several prefixes, so a file categorized under ANY of them leaves the bucket', async () => {
    // The merged-tree shape: a file categorized in one lake is reachable under that lake's branch,
    // so it must not appear in the all-lakes bucket even though it is loose in the other lake.
    // `categorized` carries acme:legal, so adding globex: to the set must not pull it back in.
    await expect(browse({ lacksContentPrefixTags: ['acme:', 'globex:'] })).resolves.toEqual(['meta-only']);
  });

  it('drops duplicate prefixes rather than repeating the conjunct', async () => {
    const once = await browse({ lacksContentPrefixTags: ['acme:'] });

    await expect(browse({ lacksContentPrefixTags: ['acme:', 'acme:', ' acme: '] })).resolves.toEqual(once);
  });

  it('is dropped rather than matching everything when a prefix is unusable', async () => {
    // An empty or colon-less prefix would build `^()` and select every file. Both fall through to
    // the unnarrowed lake list instead.
    const all = await browse();

    await expect(browse({ lacksContentPrefixTags: [''] })).resolves.toEqual(all);
    await expect(browse({ lacksContentPrefixTags: ['acme'] })).resolves.toEqual(all);
    await expect(browse({ lacksContentPrefixTags: [] })).resolves.toEqual(all);
  });
});
