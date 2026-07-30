import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// Real-Mongo round-trips for the restrictToFileIds allow-list: proves the restriction
// holds through Mongoose _id casting and the executeSearch pipeline, not just the
// query-builder object shape (covered in fabFileSearchQuery.test.ts).
describe('FabFileRepository.search restrictToFileIds allow-list', () => {
  setupMongoTest();

  const userId = 'restrict-test-user';
  const pagination = { page: 1, limit: 20 };
  const order = { by: 'fileName', direction: 'asc' } as const;

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  async function seedThreeMatchingFiles(): Promise<string[]> {
    const docs = await FabFile.create(
      ['widget-alpha.txt', 'widget-beta.txt', 'widget-gamma.txt'].map(fileName => ({
        userId,
        fileName,
        type: KnowledgeType.FILE,
        mimeType: 'text/plain',
      }))
    );
    return docs.map(d => d.id as string);
  }

  it('returns ONLY allow-listed files even when other files match for the same user', async () => {
    const [alphaId, betaId] = await seedThreeMatchingFiles();

    const result = await fabFileRepository.search(
      userId,
      'widget',
      { restrictToFileIds: [alphaId, betaId] },
      pagination,
      order
    );

    expect(result.total).toBe(2);
    expect(result.data.map(f => f.id).sort()).toEqual([alphaId, betaId].sort());
  });

  it('an empty allow-list returns nothing (fail-closed), never the unrestricted set', async () => {
    await seedThreeMatchingFiles();

    const result = await fabFileRepository.search(userId, 'widget', { restrictToFileIds: [] }, pagination, order);

    expect(result.total).toBe(0);
    expect(result.data).toEqual([]);
  });

  it('nonexistent ids in the allow-list return nothing rather than erroring', async () => {
    await seedThreeMatchingFiles();

    const result = await fabFileRepository.search(
      userId,
      'widget',
      { restrictToFileIds: ['64b000000000000000000000'] },
      pagination,
      order
    );

    expect(result.total).toBe(0);
  });

  it('still applies the owner filter: an allow-listed id owned by ANOTHER user is not returned', async () => {
    const [alphaId] = await seedThreeMatchingFiles();
    const foreign = await FabFile.create({
      userId: 'someone-else',
      fileName: 'widget-foreign.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
    });

    const result = await fabFileRepository.search(
      userId,
      'widget',
      { restrictToFileIds: [alphaId, foreign.id as string] },
      pagination,
      order,
      { includeShared: false }
    );

    expect(result.data.map(f => f.id)).toEqual([alphaId]);
  });

  it('skipOwnership serves an allow-listed file owned by another user (curation is the grant)', async () => {
    const [alphaId] = await seedThreeMatchingFiles();
    const foreign = await FabFile.create({
      userId: 'teammate',
      fileName: 'widget-teammate.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
    });

    const result = await fabFileRepository.search(
      userId,
      'widget',
      { restrictToFileIds: [alphaId, foreign.id as string] },
      pagination,
      order,
      { includeShared: false, skipOwnership: true }
    );

    expect(result.data.map(f => f.id).sort()).toEqual([alphaId, foreign.id as string].sort());
  });
});

// Real-Mongo round-trips for the two data-lake prefix buckets. fabFileSearchQuery.test.ts
// asserts the SHAPE of the emitted $or arms; these prove Mongo actually evaluates them the
// way the shape implies - that the SCOPED arm's $and really does confine a user-controlled
// prefix to the owner, and that the OPEN arm really does reach past ownership. Both buckets
// now feed the semantic-search endpoint, so a regression here is a cross-tenant read.
describe('FabFileRepository.search data-lake tag prefixes', () => {
  setupMongoTest();

  const ownerId = 'lake-owner';
  const otherTenantId = 'other-tenant';
  const pagination = { page: 1, limit: 20 };
  const order = { by: 'fileName', direction: 'asc' } as const;

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  const seedTagged = (userId: string, fileName: string, tagName: string) =>
    FabFile.create({
      userId,
      fileName,
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [{ name: tagName }],
    });

  it('a SCOPED prefix does not reach another tenant who picked the same prefix', async () => {
    // Nothing reserves a dynamic lake's fileTagPrefix, so two tenants can and will collide.
    const mine = await seedTagged(ownerId, 'mine.txt', 'acme:spec');
    await seedTagged(otherTenantId, 'theirs.txt', 'acme:spec');

    const result = await fabFileRepository.search(ownerId, '', {}, pagination, order, {
      includeShared: true,
      scopedTagPrefixes: ['acme:'],
    });

    expect(result.data.map(f => f.id)).toEqual([mine.id as string]);
  });

  it('a SCOPED prefix is the only grant under restrictToDataLake, and it stays owner-bound', async () => {
    // restrictToDataLake drops the broad ownership arms, so the scoped prefix arm is the ONLY
    // thing selecting files - the owner's file can only arrive through the arm under test.
    const mine = await seedTagged(ownerId, 'mine.txt', 'acme:spec');
    await seedTagged(otherTenantId, 'theirs.txt', 'acme:spec');
    await seedTagged(ownerId, 'unrelated.txt', 'personal:note');

    const result = await fabFileRepository.search(ownerId, '', {}, pagination, order, {
      includeShared: true,
      scopedTagPrefixes: ['acme:'],
      restrictToDataLake: true,
    });

    expect(result.data.map(f => f.id)).toEqual([mine.id as string]);
  });

  it('an OPEN prefix does reach another user file (the shared-KB bypass, by design)', async () => {
    const theirs = await seedTagged(otherTenantId, 'shared-kb.txt', 'opti:article');

    const result = await fabFileRepository.search(ownerId, '', {}, pagination, order, {
      includeShared: true,
      dataLakeTagPrefixes: ['opti:'],
    });

    expect(result.data.map(f => f.id)).toEqual([theirs.id as string]);
  });

  it('the meta-tag reaches another user file without a prefix (unique per lake, so safe)', async () => {
    const theirs = await seedTagged(otherTenantId, 'lake-member.txt', 'datalake:acme:handbook');

    const result = await fabFileRepository.search(ownerId, '', {}, pagination, order, {
      includeShared: true,
      dataLakeTags: ['datalake:acme:handbook'],
    });

    expect(result.data.map(f => f.id)).toEqual([theirs.id as string]);
  });

  it('passing a dynamic prefix in the OPEN bucket WOULD leak - the split is what prevents it', async () => {
    // Characterizes why resolveRetrievalLakeScope must never promote a scoped prefix: the same
    // prefix string leaks across tenants in the OPEN bucket and does not in the SCOPED one.
    await seedTagged(otherTenantId, 'theirs.txt', 'acme:spec');

    const leaked = await fabFileRepository.search(ownerId, '', {}, pagination, order, {
      includeShared: true,
      dataLakeTagPrefixes: ['acme:'],
    });
    const contained = await fabFileRepository.search(ownerId, '', {}, pagination, order, {
      includeShared: true,
      scopedTagPrefixes: ['acme:'],
    });

    expect(leaked.total).toBe(1);
    expect(contained.total).toBe(0);
  });
});

// The promise behind removing a file from a lake: it stops appearing in that lake. Asserted
// against the lake read scope itself rather than the mutation, because the defect was that the
// two disagreed - the write cleared one membership signal and the scope honored two.
describe('a file removed from a lake no longer matches that lake read scope', () => {
  setupMongoTest();

  const ownerId = 'lake-owner';
  const pagination = { page: 1, limit: 20 };
  const order = { by: 'fileName', direction: 'asc' } as const;

  const LAKE = { datalakeTag: 'datalake:org:mylake', fileTagPrefix: 'mylake:' };
  const OTHER_LAKE = { datalakeTag: 'datalake:org:otherlake', fileTagPrefix: 'other:' };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  const seed = (fileName: string, tagNames: string[]) =>
    FabFile.create({
      userId: ownerId,
      fileName,
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: tagNames.map(name => ({ name, strength: 1 })),
    });

  // The single-lake browser's option set, verbatim (see the lake articles route). Keep in sync:
  // if that route's scope widens, removal has to clear whatever the new arm matches.
  const browseLake = (lake: { datalakeTag: string; fileTagPrefix: string }) =>
    fabFileRepository.search(ownerId, '', {}, pagination, order, {
      includeShared: true,
      userGroups: [],
      dataLakeTags: [lake.datalakeTag],
      scopedTagPrefixes: [lake.fileTagPrefix],
      restrictToDataLake: true,
      excludeContent: true,
    });

  const removeFromLake = async (fileId: string, lake: { datalakeTag: string; fileTagPrefix: string }) => {
    const doc = await FabFile.findById(fileId);
    const names = (doc?.tags ?? []).map(t => (t as { name: string }).name);
    await fabFileRepository.pullTagsByFabFileId(fileId, [
      lake.datalakeTag,
      ...names.filter(name => name.startsWith(lake.fileTagPrefix)),
    ]);
  };

  it('drops a wizard-ingested file carrying BOTH the meta-tag and a prefixed tag', async () => {
    // Pulling only the meta-tag left this file matching the prefix arm forever, which is the
    // bug: the lake count said it was gone while the browse and retrieval still served it.
    const file = await seed('invoice.pdf', ['mylake:invoices', LAKE.datalakeTag]);
    expect((await browseLake(LAKE)).total).toBe(1);

    await removeFromLake(file.id as string, LAKE);

    expect((await browseLake(LAKE)).total).toBe(0);
  });

  it('still matches the lake when only the meta-tag is cleared', async () => {
    // Characterizes the read scope that made the old removal insufficient, and pins the reason
    // removal has to clear both signals. If the prefix arm is ever dropped from the lake scope,
    // this goes red and whoever does it can see the tradeoff instead of guessing.
    const file = await seed('invoice.pdf', ['mylake:invoices', LAKE.datalakeTag]);

    await fabFileRepository.pullTagsByFabFileId(file.id as string, [LAKE.datalakeTag]);

    expect((await browseLake(LAKE)).total).toBe(1);
  });

  it('drops a file whose only membership signal is a prefixed tag', async () => {
    const file = await seed('legacy.pdf', ['mylake:invoices']);
    // The prefix arm is a real grant, so this file IS a member as far as the browse is concerned.
    expect((await browseLake(LAKE)).total).toBe(1);

    await removeFromLake(file.id as string, LAKE);

    expect((await browseLake(LAKE)).total).toBe(0);
  });

  it('leaves the file in a second lake it also belongs to', async () => {
    const file = await seed('shared.pdf', [
      'mylake:invoices',
      LAKE.datalakeTag,
      'other:handbook',
      OTHER_LAKE.datalakeTag,
    ]);

    await removeFromLake(file.id as string, LAKE);

    expect((await browseLake(LAKE)).total).toBe(0);
    expect((await browseLake(OTHER_LAKE)).data.map(f => f.id)).toEqual([file.id as string]);
  });
});
