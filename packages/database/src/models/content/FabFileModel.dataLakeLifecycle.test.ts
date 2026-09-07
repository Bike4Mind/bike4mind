import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, type DataLakeMembershipScope } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { buildDataLakeMembershipFilter } from '../../queries/dataLakeLifecycleScope';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFile.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
});

const DATALAKE_TAG = 'datalake:org1:acme-docs';
const CREATOR = 'u-lake-creator';
const STRANGER = 'u-stranger';
const CREATOR_GROUP = 'g-creator';

const scope: DataLakeMembershipScope = {
  datalakeTag: DATALAKE_TAG,
  fileTagPrefix: 'acme:',
  creatorUserId: CREATOR,
};

/** The pre-fix scope: what these methods matched when they only knew the meta-tag. */
const metaOnlyScope: DataLakeMembershipScope = { datalakeTag: DATALAKE_TAG };

const makeFile = async (
  overrides: Record<string, unknown> & { fileName: string; userId: string; tags: { name: string }[] }
) =>
  FabFile.create({
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: overrides.fileName,
    fileSize: 100,
    status: 'complete',
    ...overrides,
  });

/**
 * The two rows that ARE members, plus three prefix-tagged rows owned by someone else that must
 * never be touched. `fileTagPrefix` has no uniqueness constraint, so the prefix arm is anchored to
 * files the creator OWNS - a read share or a group share must not make a stranger's file a member,
 * because these queries archive and hard-delete what they match.
 */
async function seedLakeRows() {
  const metaTagged = await makeFile({
    fileName: 'meta.txt',
    userId: CREATOR,
    tags: [{ name: DATALAKE_TAG }],
  });
  const prefixOwned = await makeFile({
    fileName: 'prefix-owned.txt',
    userId: CREATOR,
    tags: [{ name: 'acme:report' }],
  });
  // Shared TO the creator, read-only. Not a member: the creator does not own it.
  const prefixSharedToCreator = await makeFile({
    fileName: 'prefix-shared.txt',
    userId: STRANGER,
    tags: [{ name: 'acme:shared' }],
    users: [{ userId: CREATOR, permissions: ['read'] }],
  });
  // Shared to a group the creator belongs to. Also not a member, for the same reason.
  const prefixSharedToCreatorGroup = await makeFile({
    fileName: 'prefix-group.txt',
    userId: STRANGER,
    tags: [{ name: 'acme:group' }],
    groups: [{ groupId: CREATOR_GROUP, permissions: ['read'] }],
  });
  const unrelated = await makeFile({
    fileName: 'unrelated.txt',
    userId: STRANGER,
    tags: [{ name: 'acme:not-yours' }],
  });

  return {
    metaTagged,
    prefixOwned,
    memberIds: [metaTagged, prefixOwned].map(f => f._id.toString()),
    // Prefix-tagged but owned by someone else, however they reach the creator.
    strangerIds: [prefixSharedToCreator, prefixSharedToCreatorGroup, unrelated].map(f => f._id.toString()),
    prefixSharedToCreator,
    prefixSharedToCreatorGroup,
    unrelated,
  };
}

const readRaw = async (id: string) => FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

describe('FabFile data lake lifecycle membership', () => {
  describe('computeDataLakeStats', () => {
    it('counts both member signals and excludes every stranger-owned prefix match', async () => {
      await seedLakeRows();

      const stats = await fabFileRepository.computeDataLakeStats(scope);

      // The meta-tagged file and the creator's own prefix-tagged file. The three stranger-owned
      // rows are excluded even though two of them are shared to the creator.
      expect(stats.fileCount).toBe(2);
      expect(stats.totalSizeBytes).toBe(200);
    });

    it('counted only the meta-tagged file before the prefix arm existed', async () => {
      await seedLakeRows();

      // Pins the bug this change fixes: fileCount read 1 while the browse listed more.
      expect(await fabFileRepository.computeDataLakeStats(metaOnlyScope)).toEqual({
        fileCount: 1,
        totalSizeBytes: 100,
        totalChunkedChars: 0,
      });
    });

    it('sums member files chunkedCharCount, treating missing as 0', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { chunkedCharCount: 1200 } });
      // prefixOwned deliberately left without the field (legacy doc).
      // Stranger-owned rows must not contribute even when stamped:
      await FabFile.updateOne({ _id: rows.unrelated._id }, { $set: { chunkedCharCount: 999 } });

      const stats = await fabFileRepository.computeDataLakeStats(scope);

      expect(stats.totalChunkedChars).toBe(1200);
    });

    it('ignores archived and deleted members', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { archivedAt: new Date() } });
      await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { deletedAt: new Date() } });

      expect((await fabFileRepository.computeDataLakeStats(scope)).fileCount).toBe(0);
    });

    it('excludes a presigned member whose bytes have not landed yet (#1342)', async () => {
      // Same exclusion countDataLakeFilesByMembership pins - counting an orphan 'pending' row
      // would let an abandoned upload permanently activate the lake.
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { status: 'pending' } });

      const stats = await fabFileRepository.computeDataLakeStats(scope);

      expect(stats.fileCount).toBe(1);
      expect(stats.totalSizeBytes).toBe(100);
    });

    it('bounds the prefix-arm scan on userId instead of examining every stranger sharing the tag prefix (#1793)', async () => {
      // autoIndex builds in the background on connect; explicitly await it here so the hints
      // below can rely on both candidate indexes actually existing.
      await FabFile.createIndexes();
      await seedLakeRows();
      const strangers = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          makeFile({ fileName: `stranger-${i}.txt`, userId: STRANGER, tags: [{ name: `acme:stranger-${i}` }] })
        )
      );

      const stats = await fabFileRepository.computeDataLakeStats(scope);
      // Sanity: the 50 strangers must not be counted, matching the exclusion pinned above.
      expect(stats.fileCount).toBe(2);

      // Derived from the REAL buildDataLakeMembershipFilter output (its second $or branch is the
      // prefix arm's $and of [tag regex, userId]), isolated from the meta-tag arm so the
      // comparison below is not muddied by an $or plan. Deriving rather than hand-copying means
      // this test cannot drift out of sync if that predicate's shape ever changes.
      type PrefixArmShape = {
        $or: [Record<string, unknown>, { $and: [Record<string, unknown>, Record<string, unknown>] }];
      };
      const membership = buildDataLakeMembershipFilter(scope) as PrefixArmShape;
      const [tagCondition, userCondition] = membership.$or[1].$and;
      const prefixArmFilter = {
        ...tagCondition,
        ...userCondition,
        deletedAt: null,
        archivedAt: null,
        status: { $ne: 'pending' },
      };

      // Compare the two candidate indexes directly via hint, rather than trusting the planner's
      // natural choice: on a collection this small the cost-based planner may prefer a plain
      // COLLSCAN over either index regardless of which is better, which would make a
      // planner-choice assertion flaky. Forcing each index isolates exactly what this PR changes:
      // whether userId or tags.name leads the compound key.
      const viaOldIndex = await FabFile.collection
        .find(prefixArmFilter)
        .hint('tags.name_1_archivedAt_1_deletedAt_1')
        .explain('executionStats');
      const viaNewIndex = await FabFile.collection
        .find(prefixArmFilter)
        .hint('userId_1_tags.name_1_archivedAt_1_deletedAt_1')
        .explain('executionStats');

      // Old index: tags.name leads, so the range covers this creator's file plus all 50
      // strangers; userId is checked only after fetching each candidate.
      expect(viaOldIndex.executionStats.totalDocsExamined).toBeGreaterThanOrEqual(strangers.length);
      // New index: userId leads, bounding the scan to this creator's own matching documents.
      expect(viaNewIndex.executionStats.totalDocsExamined).toBeLessThan(strangers.length);
      expect(viaNewIndex.executionStats.totalDocsExamined).toBeLessThan(viaOldIndex.executionStats.totalDocsExamined);
    });
  });

  // #1040: the single-lake browse (fabFileRepository.search with lakeMembership +
  // restrictToDataLake, what GET /api/data-lakes/:id/articles runs) must agree with
  // computeDataLakeStats above about who is a member - a file only reached through a share or a
  // group grant is excluded from the listing itself, not merely from the count, so it can never
  // be "listed but unremovable".
  describe('search under a single-lake browse scope (lakeMemberships)', () => {
    const pagination = { page: 1, limit: 20 };
    const order = { by: 'fileName', direction: 'asc' } as const;

    it('lists exactly the members computeDataLakeStats counts, excluding every stranger-owned prefix match', async () => {
      const rows = await seedLakeRows();

      const result = await fabFileRepository.search(CREATOR, '', {}, pagination, order, {
        includeShared: true,
        userGroups: [CREATOR_GROUP],
        lakeMemberships: [scope],
        restrictToDataLake: true,
      });

      expect(result.data.map(f => f.fileName).sort()).toEqual(['meta.txt', 'prefix-owned.txt']);
      const listedIds = result.data.map(f => f.id);
      for (const id of rows.strangerIds) {
        expect(listedIds).not.toContain(id);
      }
    });
  });

  // #2243: retrieval must resolve a dynamic lake's prefix arm against THAT LAKE'S CREATOR, exactly
  // as membership does - never against the caller, and never as a bare prefix. These drive the
  // real query (not just inspect a filter object), because only the executed search proves the
  // tenancy boundary through casting and executeSearch.
  describe('lakeMemberships parity with buildDataLakeMembershipFilter (#2243)', () => {
    const pagination = { page: 1, limit: 20 };
    const order = { by: 'fileName', direction: 'asc' } as const;
    const VIEWER = 'u-viewer-not-creator';

    it('a non-creator VIEWER reaches the prefix-only member only once lakeMemberships replaces the caller-anchored arm', async () => {
      await seedLakeRows();

      // Old shape: the meta-tag arm alone. This is what the caller-anchored `scopedTagPrefixes`
      // option degraded to for a non-creator - its prefix arm was `prefix AND base access`, a
      // strict subset of an arm already present, so it could never admit a creator-owned file.
      // Only the lake arm differs between "before" and "after" here.
      const before = await fabFileRepository.search(VIEWER, '', {}, pagination, order, {
        includeShared: true,
        dataLakeTags: [DATALAKE_TAG],
      });
      expect(before.data.map(f => f.fileName).sort()).toEqual(['meta.txt']);

      // New shape: the creator-anchored membership arm reaches the prefix-only member too.
      const after = await fabFileRepository.search(VIEWER, '', {}, pagination, order, {
        includeShared: true,
        dataLakeTags: [DATALAKE_TAG],
        lakeMemberships: [scope],
      });
      expect(after.data.map(f => f.fileName).sort()).toEqual(['meta.txt', 'prefix-owned.txt']);
    });

    it("a VIEWER's search total equals the single-lake browse's own total for the same lake and caller", async () => {
      await seedLakeRows();

      const browse = await fabFileRepository.search(CREATOR, '', {}, pagination, order, {
        includeShared: true,
        userGroups: [CREATOR_GROUP],
        lakeMemberships: [scope],
        restrictToDataLake: true,
      });
      const viewerRetrieval = await fabFileRepository.search(VIEWER, '', {}, pagination, order, {
        includeShared: true,
        dataLakeTags: [DATALAKE_TAG],
        lakeMemberships: [scope],
      });

      // Precondition this equality relies on: seedLakeRows() seeds no pending and no
      // session-scoped row, so buildFabFileSearchQuery's (status-blind) filter and
      // computeDataLakeStats's ($ne: 'pending') filter would otherwise disagree - see
      // dataLakeLifecycle's own note on why an unqualified fileCount comparison is unsound.
      expect(viewerRetrieval.total).toBe(browse.total);
      expect(viewerRetrieval.data.map(f => f.fileName).sort()).toEqual(browse.data.map(f => f.fileName).sort());
    });

    it('two lakes sharing a prefix under DIFFERENT creators never cross - each caller sees only their own creator arm', async () => {
      await seedLakeRows();
      const otherCreator = 'u-other-creator';
      const otherTag = 'datalake:org2:globex-docs';
      await makeFile({
        fileName: 'other-meta.txt',
        userId: otherCreator,
        tags: [{ name: otherTag }],
      });
      const otherPrefixOwned = await makeFile({
        fileName: 'other-prefix-owned.txt',
        userId: otherCreator,
        tags: [{ name: 'acme:other-report' }], // SAME prefix as `scope`, different creator
      });
      const otherScope: DataLakeMembershipScope = {
        datalakeTag: otherTag,
        fileTagPrefix: 'acme:',
        creatorUserId: otherCreator,
      };

      const asOriginalCreatorViewer = await fabFileRepository.search(VIEWER, '', {}, pagination, order, {
        includeShared: true,
        dataLakeTags: [DATALAKE_TAG],
        lakeMemberships: [scope],
      });
      expect(asOriginalCreatorViewer.data.map(f => f.fileName)).not.toContain('other-prefix-owned.txt');

      const asOtherCreatorViewer = await fabFileRepository.search(VIEWER, '', {}, pagination, order, {
        includeShared: true,
        dataLakeTags: [otherTag],
        lakeMemberships: [otherScope],
      });
      expect(asOtherCreatorViewer.data.map(f => f.fileName)).not.toContain('prefix-owned.txt');
      expect(asOtherCreatorViewer.data.map(f => f.fileName)).not.toContain('unrelated.txt');
      const otherIds = asOtherCreatorViewer.data.map(f => f.id);
      expect(otherIds).toContain(otherPrefixOwned._id.toString());
    });

    it('a file matching both a caller membership arm and their own ownership is returned once', async () => {
      await seedLakeRows();
      // The creator IS the searching viewer here, so prefix-owned.txt matches both the bare
      // {userId} base-access arm AND the membership arm - dedupe must collapse it to one row.
      const result = await fabFileRepository.search(CREATOR, '', {}, pagination, order, {
        includeShared: true,
        dataLakeTags: [DATALAKE_TAG],
        lakeMemberships: [scope],
      });
      const names = result.data.map(f => f.fileName);
      expect(names.filter(n => n === 'prefix-owned.txt')).toHaveLength(1);
      expect(result.total).toBe(names.length);
    });

    it("an empty creatorUserId under restrictToDataLake matches meta-tagged only, never the caller's own colliding-prefix file", async () => {
      await seedLakeRows();
      // The CREATOR's own file is prefix-owned.txt (tag acme:report) - if the empty-creator scope
      // fell through to matching the caller, this would wrongly include it.
      const creatorlessScope: DataLakeMembershipScope = {
        datalakeTag: DATALAKE_TAG,
        fileTagPrefix: 'acme:',
        creatorUserId: '',
      };
      const result = await fabFileRepository.search(CREATOR, '', {}, pagination, order, {
        includeShared: true,
        lakeMemberships: [creatorlessScope],
        restrictToDataLake: true,
      });
      expect(result.data.map(f => f.fileName)).toEqual(['meta.txt']);
    });

    it('a prefix carrying regex metacharacters matches literally, not as a pattern', async () => {
      const weirdCreator = 'u-weird-creator';
      const weirdTag = 'datalake:org1:weird';
      await makeFile({
        fileName: 'weird-owned.txt',
        userId: weirdCreator,
        tags: [{ name: 'a.b+c:report' }],
      });
      await makeFile({
        fileName: 'weird-not-a-match.txt',
        userId: weirdCreator,
        tags: [{ name: 'aXbYc:report' }], // would match the UNESCAPED `.` and `+` as regex metachars
      });
      const weirdScope: DataLakeMembershipScope = {
        datalakeTag: weirdTag,
        fileTagPrefix: 'a.b+c:',
        creatorUserId: weirdCreator,
      };
      const result = await fabFileRepository.search(weirdCreator, '', {}, pagination, order, {
        includeShared: true,
        lakeMemberships: [weirdScope],
        restrictToDataLake: true,
      });
      expect(result.data.map(f => f.fileName)).toEqual(['weird-owned.txt']);
    });
  });

  describe('getAccessibleFiles - lake membership arm (#1576)', () => {
    const VIEWER = 'u-viewer-not-creator';

    it('a non-owner reaches a meta-tagged member and a creator-owned prefix-only member, never a colliding-prefix stranger', async () => {
      const rows = await seedLakeRows();
      const viewerCaslScope = { userId: VIEWER };

      const result = await fabFileRepository.getAccessibleFiles(
        [rows.metaTagged._id.toString(), rows.prefixOwned._id.toString(), ...rows.strangerIds],
        viewerCaslScope,
        { lakeMemberships: [scope] }
      );

      expect(result.map(f => f.fileName).sort()).toEqual(['meta.txt', 'prefix-owned.txt']);
    });

    it('two lakes sharing a prefix under different creators never cross on the attachment door either', async () => {
      await seedLakeRows();
      const otherCreator = 'u-other-creator-attach';
      const otherPrefixOwned = await makeFile({
        fileName: 'other-prefix-owned-attach.txt',
        userId: otherCreator,
        tags: [{ name: 'acme:other-report-attach' }], // same prefix as `scope`, different creator
      });
      const viewerCaslScope = { userId: VIEWER };

      const result = await fabFileRepository.getAccessibleFiles(
        [otherPrefixOwned._id.toString()],
        viewerCaslScope,
        { lakeMemberships: [scope] } // only the ORIGINAL creator's arm, not `otherCreator`'s
      );

      expect(result).toHaveLength(0);
    });

    it('a file matching both the CASL scope and a lake arm is returned once, not duplicated', async () => {
      const rows = await seedLakeRows();
      const creatorCaslScope = { userId: CREATOR };

      const result = await fabFileRepository.getAccessibleFiles([rows.prefixOwned._id.toString()], creatorCaslScope, {
        lakeMemberships: [scope],
      });

      expect(result).toHaveLength(1);
    });

    it("an archived lake member is not returned through the lake arm, while the caller's OWN archived file still is", async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { archivedAt: new Date() } });
      const ownArchived = await makeFile({
        fileName: 'own-archived.txt',
        userId: VIEWER,
        tags: [],
        archivedAt: new Date(),
      });
      const viewerCaslScope = { userId: VIEWER };

      const result = await fabFileRepository.getAccessibleFiles(
        [rows.metaTagged._id.toString(), ownArchived._id.toString()],
        viewerCaslScope,
        { lakeMemberships: [scope] }
      );

      expect(result.map(f => f.fileName)).toEqual(['own-archived.txt']);
    });

    it('forwards the dataLakeTags bucket: a non-owner reaches a meta-tagged member by tag alone', async () => {
      const rows = await seedLakeRows();
      const viewerCaslScope = { userId: VIEWER };

      const result = await fabFileRepository.getAccessibleFiles(
        [rows.metaTagged._id.toString(), rows.prefixOwned._id.toString(), ...rows.strangerIds],
        viewerCaslScope,
        { dataLakeTags: [DATALAKE_TAG] }
      );

      // The exact meta-tag arm only: prefix-owned.txt carries no datalake: tag, so this bucket
      // alone must not reach it, and no stranger carries the tag either.
      expect(result.map(f => f.fileName)).toEqual(['meta.txt']);
    });

    it('forwards the dataLakeTagPrefixes bucket, which is UNANCHORED - it reaches prefix matches the caller does not own', async () => {
      const rows = await seedLakeRows();
      const viewerCaslScope = { userId: VIEWER };

      const result = await fabFileRepository.getAccessibleFiles(
        [rows.metaTagged._id.toString(), rows.prefixOwned._id.toString(), ...rows.strangerIds],
        viewerCaslScope,
        { dataLakeTagPrefixes: ['acme:'] }
      );

      // Pinning the widest arm this door can be handed. Unlike a `lakeMemberships` scope, the
      // prefix bucket carries NO creator conjunct, so every acme:-tagged file matches regardless
      // of owner - which is why it is only ever supplied for a registry lake on an access-gated
      // path, and why lakeMembershipsFrom's `owned` allow-list must keep registry scopes out of
      // lakeMemberships. A regression that widened this bucket's source would show up here.
      expect(result.map(f => f.fileName).sort()).toEqual([
        'prefix-group.txt',
        'prefix-owned.txt',
        'prefix-shared.txt',
        'unrelated.txt',
      ]);
    });

    it('an absent lakeAccess, or one with empty buckets, reproduces the byte-identical legacy result set', async () => {
      const rows = await seedLakeRows();
      const creatorCaslScope = { userId: CREATOR };
      const ids = [rows.metaTagged._id.toString(), rows.prefixOwned._id.toString(), ...rows.strangerIds];

      const withoutLakeAccess = await fabFileRepository.getAccessibleFiles(ids, creatorCaslScope);
      const withEmptyBuckets = await fabFileRepository.getAccessibleFiles(ids, creatorCaslScope, {});

      const names = (rows: typeof withoutLakeAccess) => rows.map(f => f.fileName).sort();
      // CREATOR owns both member files outright, so ownership alone (no lake arm) already
      // reaches them - this pins that adding the parameter changes nothing when it's unused.
      expect(names(withoutLakeAccess)).toEqual(['meta.txt', 'prefix-owned.txt']);
      expect(names(withEmptyBuckets)).toEqual(names(withoutLakeAccess));
    });
  });

  describe('archiveByDataLakeTag / unarchiveByDataLakeTag', () => {
    it('archives the members and leaves every stranger-owned prefix match live', async () => {
      const rows = await seedLakeRows();

      const archived = await fabFileRepository.archiveByDataLakeTag(scope);

      expect(archived).toBe(2);
      for (const id of rows.memberIds) {
        expect((await readRaw(id))?.archivedAt).not.toBeNull();
      }
      // Including the two shared to the creator: hiding a file someone else owns is not this
      // operation's business, and a read share must not make it a lake member.
      for (const id of rows.strangerIds) {
        const row = await readRaw(id);
        expect(row?.archivedAt ?? null).toBeNull();
        expect(row?.deletedAt ?? null).toBeNull();
      }
    });

    it('restores everything it archived when the stamp names it', async () => {
      const rows = await seedLakeRows();
      const STAMP = new Date('2026-06-01T00:00:00.000Z');

      await fabFileRepository.archiveByDataLakeTag(scope, STAMP);
      const restored = await fabFileRepository.unarchiveByDataLakeTag(scope, STAMP);

      expect(restored).toBe(2);
      for (const id of rows.memberIds) {
        expect((await readRaw(id))?.archivedAt ?? null).toBeNull();
      }
    });

    it('leaves a differently-stamped prefix member untouched - a sibling lake, or a self-drifted stamp the mechanism cannot tell apart from one', async () => {
      const rows = await seedLakeRows();
      const OWN_STAMP = new Date('2026-06-01T00:00:00.000Z');
      const OTHER_STAMP = new Date('2026-05-01T00:00:00.000Z');
      // prefixOwned carries no meta-tag, so it is reachable ONLY through the ambiguous prefix arm -
      // exactly the row a prefix-sharing sibling's own archive could also have stamped this way.
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { archivedAt: OTHER_STAMP } });

      const restored = await fabFileRepository.unarchiveByDataLakeTag(scope, OWN_STAMP);

      expect(restored).toBe(0);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.archivedAt?.getTime()).toBe(OTHER_STAMP.getTime());
    });

    it('leaves a differently-stamped META-TAGGED member untouched too, proving the bound is not exempt on that arm', async () => {
      const rows = await seedLakeRows();
      const OWN_STAMP = new Date('2026-06-01T00:00:00.000Z');
      const OTHER_STAMP = new Date('2026-05-01T00:00:00.000Z');
      await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { archivedAt: OTHER_STAMP } });

      const restored = await fabFileRepository.unarchiveByDataLakeTag(scope, OWN_STAMP);

      expect(restored).toBe(0);
      expect((await readRaw(rows.metaTagged._id.toString()))?.archivedAt?.getTime()).toBe(OTHER_STAMP.getTime());
    });

    it('leaves a co-owned member archived when a lake it ALSO belongs to swept it first (addFileToLake allows multi-lake meta-tag membership)', async () => {
      // A file can carry more than one lake's meta-tag at once - addFileToLake has no exclusivity
      // check. Lake B's sweep only touches archivedAt: null rows, so once B archives this file
      // under its own stamp, lake A's own (unrelated) archive/unarchive cycle must not touch it,
      // even though A's meta-tag arm matches it unconditionally on membership.
      const SIBLING_TAG = 'datalake:org1:sibling-lake';
      const coMember = await makeFile({
        fileName: 'co-member.txt',
        userId: CREATOR,
        tags: [{ name: DATALAKE_TAG }, { name: SIBLING_TAG }],
      });
      const SIBLING_STAMP = new Date('2026-05-01T00:00:00.000Z');
      await FabFile.updateOne({ _id: coMember._id }, { $set: { archivedAt: SIBLING_STAMP } });
      const OWN_STAMP = new Date('2026-06-01T00:00:00.000Z');

      const restored = await fabFileRepository.unarchiveByDataLakeTag(scope, OWN_STAMP);

      expect(restored).toBe(0);
      expect((await readRaw(coMember._id.toString()))?.archivedAt?.getTime()).toBe(SIBLING_STAMP.getTime());
    });

    it('falls back to unbounded when this lake has no stamp at all (legacy, pre-mark lake)', async () => {
      const rows = await seedLakeRows();

      // archiveByDataLakeTag with no `at` still writes a real per-row timestamp (orphaned, no lake
      // names it) - the lake itself passes `undefined` below, as it would for a lake torn down
      // before `filesArchivedAt` existed.
      await fabFileRepository.archiveByDataLakeTag(scope);
      const restored = await fabFileRepository.unarchiveByDataLakeTag(scope);

      expect(restored).toBe(2);
      for (const id of rows.memberIds) {
        expect((await readRaw(id))?.archivedAt ?? null).toBeNull();
      }
    });

    it('sends the equality bound to Mongo, not just an end-state that could pass by luck', async () => {
      await seedLakeRows();
      const OWN_STAMP = new Date('2026-06-01T00:00:00.000Z');
      const spy = vi.spyOn(FabFile, 'updateMany');

      await fabFileRepository.unarchiveByDataLakeTag(scope, OWN_STAMP);

      expect(spy).toHaveBeenCalledTimes(1);
      const filter = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(filter.archivedAt).toBe(OWN_STAMP);
      spy.mockRestore();
    });

    it("is safe to retry after a completed sweep: a second call does not free a sibling's differently-stamped member", async () => {
      const rows = await seedLakeRows();
      const OWN_STAMP = new Date('2026-06-01T00:00:00.000Z');
      const SIBLING_STAMP = new Date('2026-05-01T00:00:00.000Z');
      await fabFileRepository.archiveByDataLakeTag(scope, OWN_STAMP);
      // Simulates a sibling lake's own archive on the shared prefix, stamped differently.
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { archivedAt: SIBLING_STAMP } });

      const first = await fabFileRepository.unarchiveByDataLakeTag(scope, OWN_STAMP);
      // The retry a crash-then-re-entry would produce: the bounded pass now matches nothing of
      // ours (already cleared), which must NOT fall back to freeing the sibling's row.
      const second = await fabFileRepository.unarchiveByDataLakeTag(scope, OWN_STAMP);

      expect(first).toBe(1);
      expect(second).toBe(0);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.archivedAt?.getTime()).toBe(SIBLING_STAMP.getTime());
    });

    it('finds archived members for the unarchive dedup pass, unbounded when no stamp is given', async () => {
      await seedLakeRows();
      await fabFileRepository.archiveByDataLakeTag(scope);

      const found = await fabFileRepository.findArchivedByDataLakeTag(scope);

      expect(found.map(f => f.fileName).sort()).toEqual(['meta.txt', 'prefix-owned.txt']);
    });

    it('excludes a differently-stamped member from the dedup read when a stamp is given, so it cannot be nominated as a duplicate and soft-deleted', async () => {
      const rows = await seedLakeRows();
      const OWN_STAMP = new Date('2026-06-01T00:00:00.000Z');
      const SIBLING_STAMP = new Date('2026-05-01T00:00:00.000Z');
      await fabFileRepository.archiveByDataLakeTag(scope, OWN_STAMP);
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { archivedAt: SIBLING_STAMP } });

      const found = await fabFileRepository.findArchivedByDataLakeTag(scope, OWN_STAMP);

      expect(found.map(f => f.fileName)).toEqual(['meta.txt']);
    });

    it('hasArchivedMemberExclusiveToDataLakeTag reports existence without materializing the rows', async () => {
      await seedLakeRows();

      expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(scope)).toBe(false);

      await fabFileRepository.archiveByDataLakeTag(scope);

      expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(scope)).toBe(true);
    });

    describe('hasArchivedMemberExclusiveToDataLakeTag - excluding a co-owning lake (#1729)', () => {
      const SIBLING_TAG = 'datalake:org1:sibling-lake';

      it("ignores an archived member that also carries another lake's meta-tag - it is that lake's under its own stamp, not this lake's orphan", async () => {
        const coMember = await makeFile({
          fileName: 'co-member.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: SIBLING_TAG }],
        });
        await FabFile.updateOne({ _id: coMember._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(false);
      });

      it('agrees with the meta-only call site when passed the full scope (meta + prefix arm), even though the real caller never does', async () => {
        // archiveDataLake.ts always calls with the meta-tag alone (see its own comment on why the
        // full scope would trip on every second archiver in a live collision) - this just confirms
        // the exclusion is not accidentally meta-only-scope-specific, in case a future caller
        // passes the full scope.
        const coMember = await makeFile({
          fileName: 'co-member-full-scope.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: SIBLING_TAG }],
        });
        await FabFile.updateOne({ _id: coMember._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(scope)).toBe(false);
      });

      it("still reports a row carrying ONLY this lake's meta-tag, the genuine legacy orphan the guard exists to protect", async () => {
        // The unrelated tag matters: it keeps this test from passing by accident if the namespace
        // regex were ever dropped entirely (which would exclude on ANY second tag, not just
        // another lake's).
        const mineOnly = await makeFile({
          fileName: 'mine-only.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: 'unrelated-content-tag' }],
        });
        await FabFile.updateOne({ _id: mineOnly._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(true);
      });

      it("ignores a row carrying THREE lakes' meta-tags", async () => {
        const triMember = await makeFile({
          fileName: 'tri-member.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: SIBLING_TAG }, { name: 'datalake:org1:third-lake' }],
        });
        await FabFile.updateOne({ _id: triMember._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(false);
      });

      it('decides per row: a genuine mine-only orphan still reports true alongside a co-tagged archived row', async () => {
        const mineOnly = await makeFile({ fileName: 'mine-only.txt', userId: CREATOR, tags: [{ name: DATALAKE_TAG }] });
        await FabFile.updateOne({ _id: mineOnly._id }, { $set: { archivedAt: new Date('2026-05-01') } });
        const coMember = await makeFile({
          fileName: 'co-member.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: SIBLING_TAG }],
        });
        await FabFile.updateOne({ _id: coMember._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(true);
      });

      it('does not trip on a co-tagged row that is not archived at all', async () => {
        await makeFile({
          fileName: 'co-member-live.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: SIBLING_TAG }],
        });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(false);
      });

      it('folds case on the namespace, so a mixed-case sibling meta-tag still excludes the row', async () => {
        const coMember = await makeFile({
          fileName: 'co-member-mixed-case.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: 'DATALAKE:Org1:Sibling' }],
        });
        await FabFile.updateOne({ _id: coMember._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(false);
      });

      it("treats a case-variant of THIS LAKE'S OWN tag as another lake's - the deliberate degenerate direction, since no lake can hold a non-canonical meta-tag anyway", async () => {
        const variant = await makeFile({
          fileName: 'own-tag-case-variant.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: 'DataLake:Org1:Acme-Docs' }],
        });
        await FabFile.updateOne({ _id: variant._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(false);
      });

      it('lets lake A claim its own stamp so its bounded unarchive leaves the co-owned member archived, instead of the unbounded fallback freeing it', async () => {
        const coMember = await makeFile({
          fileName: 'co-member.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: SIBLING_TAG }],
        });
        const SIBLING_STAMP = new Date('2026-05-01T00:00:00.000Z');
        await FabFile.updateOne({ _id: coMember._id }, { $set: { archivedAt: SIBLING_STAMP } });
        const liveOwnMember = await makeFile({
          fileName: 'own-member.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }],
        });
        const OWN_STAMP = new Date('2026-06-01T00:00:00.000Z');

        // What archiveDataLake's guard asks before deciding to claim: false here means "claim".
        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(false);

        // The sweep only touches archivedAt: null rows, so the already-archived co-member is
        // never re-stamped - it archives just the live member under lake A's OWN stamp.
        expect(await fabFileRepository.archiveByDataLakeTag(scope, OWN_STAMP)).toBe(1);
        expect(await fabFileRepository.unarchiveByDataLakeTag(scope, OWN_STAMP)).toBe(1);
        expect((await readRaw(liveOwnMember._id.toString()))?.archivedAt ?? null).toBeNull();
        expect((await readRaw(coMember._id.toString()))?.archivedAt?.getTime()).toBe(SIBLING_STAMP.getTime());

        // Naming the damage the claim prevents: the unbounded call a permanently-unstamped lake
        // (the pre-fix behavior) would have made instead frees the co-owner's row.
        expect(await fabFileRepository.unarchiveByDataLakeTag(scope)).toBe(1);
        expect((await readRaw(coMember._id.toString()))?.archivedAt ?? null).toBeNull();
      });
    });

    describe('hasArchivedMemberExclusiveToDataLakeTag - the residual prefix-arm limitation, ratified not fixed (#1729)', () => {
      it("still reports true for a row carrying ONLY this lake's meta-tag that a prefix-sharing sibling's own sweep independently archived - no per-file attribution exists to tell the two apart", async () => {
        // No second DataLake document is needed: the probe only reads FabFile tags/archivedAt, so
        // a row satisfying a sibling's PREFIX arm (same creator, a tag under a shared prefix) while
        // carrying ONLY this lake's META tag is indistinguishable here from a genuine orphan -
        // that is precisely the accepted limitation this test pins.
        const prefixArmVictim = await makeFile({
          fileName: 'prefix-arm-victim.txt',
          userId: CREATOR,
          tags: [{ name: DATALAKE_TAG }, { name: 'acme:shared-prefix-content' }],
        });
        await FabFile.updateOne({ _id: prefixArmVictim._id }, { $set: { archivedAt: new Date('2026-05-01') } });

        expect(await fabFileRepository.hasArchivedMemberExclusiveToDataLakeTag(metaOnlyScope)).toBe(true);
      });
    });
  });

  describe('softDeleteByDataLakeTag / undeleteByDataLakeTag', () => {
    it('soft-deletes the members and spares every stranger-owned prefix match', async () => {
      const rows = await seedLakeRows();

      const ids = await fabFileRepository.softDeleteByDataLakeTag(scope);

      expect(ids.sort()).toEqual([...rows.memberIds].sort());
      for (const id of rows.strangerIds) {
        expect((await readRaw(id))?.deletedAt ?? null).toBeNull();
      }
    });

    it('round-trips a prefix-only member back to live', async () => {
      const rows = await seedLakeRows();

      await fabFileRepository.softDeleteByDataLakeTag(scope);
      const restored = await fabFileRepository.undeleteByDataLakeTag(scope);

      expect(restored).toBe(2);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.deletedAt ?? null).toBeNull();
    });

    it('honours excludeIds so a discarded duplicate stays deleted', async () => {
      const rows = await seedLakeRows();
      await fabFileRepository.softDeleteByDataLakeTag(scope);

      const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [rows.prefixOwned._id.toString()]);

      expect(restored).toBe(1);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.deletedAt).not.toBeNull();
    });

    it('finds soft-deleted members for the restore dedup pass', async () => {
      await seedLakeRows();
      await fabFileRepository.softDeleteByDataLakeTag(scope);

      const found = await fabFileRepository.findDeletedByDataLakeTag(scope);

      expect(found).toHaveLength(2);
    });
  });

  // A teardown stamps one shared value across the rows it flips and the lake records it, so the
  // reversal can name that batch exactly. What these pin is that "exactly" is equality: a range
  // would readmit a file the creator deleted on their own on either side of the teardown.
  describe('stamp-keyed teardown batches', () => {
    const EARLIER = new Date('2026-01-01T00:00:00.000Z');
    const STAMP = new Date('2026-06-01T00:00:00.000Z');
    const LATER = new Date('2026-07-01T00:00:00.000Z');

    /** A member the creator had already deleted on their own, at its own unrelated stamp. */
    const deleteIndependently = (id: mongoose.Types.ObjectId, at: Date) =>
      FabFile.updateOne({ _id: id }, { $set: { deletedAt: at } });

    describe('delete axis', () => {
      it('writes the caller stamp on every row it flips', async () => {
        const rows = await seedLakeRows();

        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        for (const id of rows.memberIds) {
          expect((await readRaw(id))?.deletedAt?.getTime()).toBe(STAMP.getTime());
        }
      });

      it('leaves an independently deleted member on its own stamp', async () => {
        const rows = await seedLakeRows();
        await deleteIndependently(rows.prefixOwned._id, EARLIER);

        const flipped = await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        expect(flipped).toEqual([rows.metaTagged._id.toString()]);
        expect((await readRaw(rows.prefixOwned._id.toString()))?.deletedAt?.getTime()).toBe(EARLIER.getTime());
      });

      it('un-deletes the named batch and nothing deleted before it', async () => {
        const rows = await seedLakeRows();
        await deleteIndependently(rows.prefixOwned._id, EARLIER);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP);

        expect(restored).toBe(1);
        expect((await readRaw(rows.metaTagged._id.toString()))?.deletedAt ?? null).toBeNull();
        expect((await readRaw(rows.prefixOwned._id.toString()))?.deletedAt?.getTime()).toBe(EARLIER.getTime());
      });

      it('un-deletes a row stamped exactly at the mark', async () => {
        // The boundary a `$gt` bound would drop on the floor - every row a teardown flips carries
        // the mark itself, so an exclusive comparison skips the whole batch.
        await seedLakeRows();
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        expect(await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP)).toBe(2);
      });

      it('leaves a member deleted DURING the window deleted', async () => {
        // The case a lower bound readmits: the per-file delete routes keep stamping members while
        // the lake sits deleted, and those deletions are the creator's, not the teardown's.
        const rows = await seedLakeRows();
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);
        const laterMember = await makeFile({
          fileName: 'added-later.txt',
          userId: CREATOR,
          tags: [{ name: 'acme:x' }],
        });
        await deleteIndependently(laterMember._id, LATER);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP);

        expect(restored).toBe(2);
        expect((await readRaw(laterMember._id.toString()))?.deletedAt?.getTime()).toBe(LATER.getTime());
        for (const id of rows.memberIds) {
          expect((await readRaw(id))?.deletedAt ?? null).toBeNull();
        }
      });

      it('reverses everything when no stamp is given, for a lake torn down before the mark existed', async () => {
        const rows = await seedLakeRows();
        await deleteIndependently(rows.prefixOwned._id, EARLIER);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        expect(await fabFileRepository.undeleteByDataLakeTag(scope)).toBe(2);
      });

      it('narrows the dedup read to the batch', async () => {
        const rows = await seedLakeRows();
        await deleteIndependently(rows.prefixOwned._id, EARLIER);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        expect((await fabFileRepository.findDeletedByDataLakeTag(scope, STAMP)).map(f => f.fileName)).toEqual([
          'meta.txt',
        ]);
        expect(await fabFileRepository.findDeletedByDataLakeTag(scope)).toHaveLength(2);
      });

      it('composes the stamp with excludeIds', async () => {
        const rows = await seedLakeRows();
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [rows.prefixOwned._id.toString()], STAMP);

        expect(restored).toBe(1);
        expect((await readRaw(rows.prefixOwned._id.toString()))?.deletedAt?.getTime()).toBe(STAMP.getTime());
      });
    });

    // Archive->delete->restore: restore also clears archivedAt, bounded the same way as the
    // delete axis - by equality against the stamp this lake's own archive wrote.
    describe('archive axis (restore also clears archivedAt)', () => {
      const ARCHIVE_STAMP = new Date('2026-05-01T00:00:00.000Z');
      const OTHER_STAMP = new Date('2026-04-01T00:00:00.000Z');

      it('writes the caller stamp on every row archiveByDataLakeTag flips', async () => {
        const rows = await seedLakeRows();

        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);

        for (const id of rows.memberIds) {
          expect((await readRaw(id))?.archivedAt?.getTime()).toBe(ARCHIVE_STAMP.getTime());
        }
      });

      it('clears archivedAt alongside deletedAt when the archive stamp matches this lake', async () => {
        const rows = await seedLakeRows();
        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP, ARCHIVE_STAMP);

        expect(restored).toBe(2);
        for (const id of rows.memberIds) {
          const row = await readRaw(id);
          expect(row?.deletedAt ?? null).toBeNull();
          expect(row?.archivedAt ?? null).toBeNull();
        }
      });

      it('splits a single mixed batch correctly: one row matches the stamp, the other does not', async () => {
        // Proves the two-partition update's arithmetic in the one case that actually exercises
        // both branches at once - every other test here has all-or-nothing rows, which cannot
        // catch a double-count or a dropped row in ownStamp.modifiedCount + otherStamp.modifiedCount.
        const rows = await seedLakeRows();
        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);
        // One member's stamp diverges after the fact (e.g. re-archived by another mechanism).
        await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { archivedAt: OTHER_STAMP } });
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP, ARCHIVE_STAMP);

        expect(restored).toBe(2);
        const matched = await readRaw(rows.metaTagged._id.toString());
        expect(matched?.deletedAt ?? null).toBeNull();
        expect(matched?.archivedAt ?? null).toBeNull();
        const diverged = await readRaw(rows.prefixOwned._id.toString());
        expect(diverged?.deletedAt ?? null).toBeNull();
        expect(diverged?.archivedAt?.getTime()).toBe(OTHER_STAMP.getTime());
      });

      it('sends the $ne bound to Mongo on the non-matching partition, not just an end-state that could pass by resolution-order luck', async () => {
        // An end-state assertion alone does not reliably catch this: removing partition B's `$ne`
        // bound (replacing it with the bare base filter) makes the two updateMany calls race on
        // shared rows against a real DB, so this file's row-level tests fail only intermittently
        // under that mutation, not every run - easy to write off as flakiness rather than catch.
        // Spying on the actual filter sent to Mongo asserts the predicate itself, not what it
        // happens to produce this run, so it fails deterministically.
        await seedLakeRows();
        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);
        const spy = vi.spyOn(FabFile, 'updateMany');

        await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP, ARCHIVE_STAMP);

        expect(spy).toHaveBeenCalledTimes(2);
        const filters = spy.mock.calls.map(call => call[0] as Record<string, unknown>);
        // Partition A: bare equality. Partition B: $ne - both must be present as sent to Mongo,
        // not merely implied by the rows this run happened to produce.
        expect(filters.some(f => f.archivedAt === ARCHIVE_STAMP)).toBe(true);
        expect(filters.some(f => JSON.stringify(f.archivedAt) === JSON.stringify({ $ne: ARCHIVE_STAMP }))).toBe(true);
        spy.mockRestore();
      });

      it('leaves a member archived under a DIFFERENT stamp untouched (a prefix-sharing sibling lake)', async () => {
        const rows = await seedLakeRows();
        // Simulates a file this lake's delete swept up (matching deletedAt) but whose archivedAt
        // was written by a different lake's archive - a different stamp this restore does not own.
        await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { archivedAt: OTHER_STAMP } });
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP, ARCHIVE_STAMP);

        expect(restored).toBe(2);
        const row = await readRaw(rows.metaTagged._id.toString());
        expect(row?.deletedAt ?? null).toBeNull();
        expect(row?.archivedAt?.getTime()).toBe(OTHER_STAMP.getTime());
      });

      it('leaves archivedAt untouched when no archive stamp is given (pre-mark lake, the known limitation)', async () => {
        const rows = await seedLakeRows();
        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP);

        expect(restored).toBe(2);
        for (const id of rows.memberIds) {
          const row = await readRaw(id);
          expect(row?.deletedAt ?? null).toBeNull();
          expect(row?.archivedAt?.getTime()).toBe(ARCHIVE_STAMP.getTime());
        }
      });

      it('never clears archivedAt on a dedup-discarded duplicate (excludeIds)', async () => {
        const rows = await seedLakeRows();
        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(
          scope,
          [rows.prefixOwned._id.toString()],
          STAMP,
          ARCHIVE_STAMP
        );

        expect(restored).toBe(1);
        const excluded = await readRaw(rows.prefixOwned._id.toString());
        expect(excluded?.deletedAt).not.toBeNull();
        expect(excluded?.archivedAt?.getTime()).toBe(ARCHIVE_STAMP.getTime());
      });

      it('leaves a file archived-by-lake but individually deleted (a different delete stamp) untouched', async () => {
        const rows = await seedLakeRows();
        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);
        // Deleted on its own, at a stamp the teardown never wrote.
        await deleteIndependently(rows.metaTagged._id, EARLIER);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP, ARCHIVE_STAMP);

        // Only prefixOwned matched the teardown's stamp; metaTagged kept its own earlier one.
        expect(restored).toBe(1);
        const independentlyDeleted = await readRaw(rows.metaTagged._id.toString());
        expect(independentlyDeleted?.deletedAt?.getTime()).toBe(EARLIER.getTime());
        expect(independentlyDeleted?.archivedAt?.getTime()).toBe(ARCHIVE_STAMP.getTime());
      });

      it('the displayed file count agrees with the Files browser after restore (the stale-count symptom)', async () => {
        const rows = await seedLakeRows();
        await fabFileRepository.archiveByDataLakeTag(scope, ARCHIVE_STAMP);
        await fabFileRepository.softDeleteByDataLakeTag(scope, STAMP);

        await fabFileRepository.undeleteByDataLakeTag(scope, [], STAMP, ARCHIVE_STAMP);

        // computeDataLakeStats is what the lake's displayed fileCount is recomputed from - it must
        // count both restored members now that neither carries a deletedAt or archivedAt marker.
        const stats = await fabFileRepository.computeDataLakeStats(scope);
        expect(stats.fileCount).toBe(rows.memberIds.length);
        for (const id of rows.memberIds) {
          const row = await readRaw(id);
          expect(row?.deletedAt ?? null).toBeNull();
          expect(row?.archivedAt ?? null).toBeNull();
        }
      });
    });
  });

  describe('findIdsByDataLakeTag / hardDeleteByDataLakeTag', () => {
    it('reports every member id including soft-deleted ones, for the chunk sweep', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { deletedAt: new Date() } });

      const ids = await fabFileRepository.findIdsByDataLakeTag(scope);

      expect(ids.sort()).toEqual([...rows.memberIds].sort());
      for (const id of rows.strangerIds) expect(ids).not.toContain(id);
    });

    it('purges the members and destroys no file the creator does not own', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.prefixSharedToCreator._id }, { $set: { deletedAt: new Date() } });

      const purged = await fabFileRepository.hardDeleteByDataLakeTag(scope);

      expect(purged.sort()).toEqual([...rows.memberIds].sort());
      for (const id of rows.memberIds) {
        expect(await readRaw(id)).toBeNull();
      }
      // The rows that must survive. Deleting your own lake cannot destroy a file another user
      // owns - not one that merely carries the same tag prefix, and not one they shared with you.
      // This runs on the hostile rows themselves, not on a mock.
      for (const id of rows.strangerIds) {
        expect(await readRaw(id)).not.toBeNull();
      }
    });

    it('left prefix-only members behind before the widening', async () => {
      const rows = await seedLakeRows();

      const purged = await fabFileRepository.hardDeleteByDataLakeTag(metaOnlyScope);

      expect(purged).toEqual([rows.metaTagged._id.toString()]);
      expect(await readRaw(rows.prefixOwned._id.toString())).not.toBeNull();
    });

    it('is idempotent on a second sweep', async () => {
      await seedLakeRows();
      await fabFileRepository.hardDeleteByDataLakeTag(scope);

      expect(await fabFileRepository.hardDeleteByDataLakeTag(scope)).toEqual([]);
    });
  });

  /**
   * The read the lake-memory extraction producer pages the lake with. It exists because the producer
   * used to resolve every id the lake had ever held and then hydrate all of them UNPROJECTED, so
   * `content`/`chunks`/`vector` reached the Lambda before the per-run cap applied - GBs on a large
   * lake, killed before its own deadline guard could yield, and killed again on every redelivery.
   * These pin the three properties that fix rests on: metadata only, live only, and bounded.
   */
  describe('findLakeMemoryExtractionMembers', () => {
    const page = (options: { after?: string | null; limit: number }) =>
      fabFileRepository.findLakeMemoryExtractionMembers(scope, options);

    it('returns both membership arms and no stranger-owned prefix match', async () => {
      const rows = await seedLakeRows();

      const members = await page({ limit: 100 });

      expect(members.map(m => m.fabFileId).sort()).toEqual([...rows.memberIds].sort());
    });

    it('projects the three fields the producer reads and NONE of the heavy payload', async () => {
      const rows = await seedLakeRows();
      // A member carrying every field the old unprojected read would have pulled into the Lambda.
      //
      // The RAW DRIVER, not `FabFile.updateOne`: none of `content`, `chunks` or `vector` is a declared
      // path on FabFileSchema, so mongoose strict mode drops all three from the update silently (the
      // same footgun the `sourceType` comment at the schema's provenance block records). Seeding through
      // mongoose leaves the document with no heavy payload at all, which makes the assertion below pass
      // for the wrong reason - it would still pass with `content: 1` added to the projection. The raw
      // driver is also how these fields reach production documents in the first place.
      await FabFile.collection.updateOne(
        { _id: rows.metaTagged._id },
        { $set: { content: 'x'.repeat(50_000), chunks: ['a', 'b'], vector: [0.1, 0.2, 0.3] } }
      );

      const [member] = await page({ limit: 1 });

      expect(Object.keys(member).sort()).toEqual(['fabFileId', 'fileName', 'tags']);
      expect(member.tags).toEqual([{ name: DATALAKE_TAG }]);
    });

    it('excludes soft-deleted and archived members in the DATABASE, not after hydration', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { deletedAt: new Date() } });
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { archivedAt: new Date() } });

      // Contrast with its lifecycle sibling, which deliberately reports both (the chunk sweep needs
      // them). A tombstone must never consume one of the producer's capped run slots.
      expect(await page({ limit: 100 })).toEqual([]);
      expect((await fabFileRepository.findIdsByDataLakeTag(scope)).sort()).toEqual([...rows.memberIds].sort());
    });

    it('pages forward from the keyset cursor in _id order and honors the limit', async () => {
      const rows = await seedLakeRows();
      const ascending = [...rows.memberIds].sort();

      const first = await page({ limit: 1 });
      expect(first.map(m => m.fabFileId)).toEqual([ascending[0]]);

      const second = await page({ after: first[0].fabFileId, limit: 1 });
      expect(second.map(m => m.fabFileId)).toEqual([ascending[1]]);

      // Past the last member: an exhausted page is empty, which is how the producer learns the scan
      // is complete and clears its cursor.
      expect(await page({ after: ascending[1], limit: 1 })).toEqual([]);
    });

    it('ignores an unparseable cursor instead of throwing the run into the DLQ', async () => {
      const rows = await seedLakeRows();

      // A re-scan is merely wasteful (the producer's ledger append de-dups); a cast error would fail
      // the invocation, and SQS would redeliver it to the same cast error.
      const members = await page({ after: 'not-an-objectid', limit: 100 });

      expect(members.map(m => m.fabFileId).sort()).toEqual([...rows.memberIds].sort());
    });
  });

  describe('hardDeleteByIds', () => {
    it('destroys exactly the ids given, soft-deleted included, and nothing a re-resolve would add', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { deletedAt: new Date() } });
      // Stands in for a file tagged into the lake after the sweep resolved its ids: a member by
      // the predicate, absent from the snapshot, and so not this run's to destroy.
      const joinedMidSweep = await makeFile({ fileName: 'late.txt', userId: CREATOR, tags: [{ name: 'acme:late' }] });

      const purged = await fabFileRepository.hardDeleteByIds(rows.memberIds);

      expect(purged.sort()).toEqual([...rows.memberIds].sort());
      for (const id of rows.memberIds) expect(await readRaw(id)).toBeNull();
      expect(await readRaw(joinedMidSweep._id.toString())).not.toBeNull();
      // Whereas the predicate-resolving door would have taken it.
      expect(await fabFileRepository.findIdsByDataLakeTag(scope)).toContain(joinedMidSweep._id.toString());
    });

    it('is a no-op on an empty set and on already-purged ids', async () => {
      const rows = await seedLakeRows();
      expect(await fabFileRepository.hardDeleteByIds([])).toEqual([]);
      await fabFileRepository.hardDeleteByIds(rows.memberIds);

      expect(await fabFileRepository.hardDeleteByIds(rows.memberIds)).toEqual(rows.memberIds);
      for (const id of rows.strangerIds) expect(await readRaw(id)).not.toBeNull();
    });
  });

  describe('fail-closed scopes', () => {
    it('touches only the meta-tagged file when the lake has no usable prefix', async () => {
      const rows = await seedLakeRows();

      const archived = await fabFileRepository.archiveByDataLakeTag({
        datalakeTag: DATALAKE_TAG,
        fileTagPrefix: '',
        creatorUserId: CREATOR,
      });

      expect(archived).toBe(1);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.archivedAt ?? null).toBeNull();
    });

    it('touches only the meta-tagged file when the creator is unknown', async () => {
      const rows = await seedLakeRows();

      const archived = await fabFileRepository.archiveByDataLakeTag({
        datalakeTag: DATALAKE_TAG,
        fileTagPrefix: 'acme:',
        creatorUserId: null,
      });

      expect(archived).toBe(1);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.archivedAt ?? null).toBeNull();
    });

    it('does not let a reserved-namespace prefix reach another lake', async () => {
      const otherLakeFile = await makeFile({
        fileName: 'other-lake.txt',
        userId: CREATOR,
        tags: [{ name: 'datalake:org1:other' }],
      });

      const archived = await fabFileRepository.archiveByDataLakeTag({
        datalakeTag: DATALAKE_TAG,
        fileTagPrefix: 'datalake:',
        creatorUserId: CREATOR,
      });

      expect(archived).toBe(0);
      expect((await readRaw(otherLakeFile._id.toString()))?.archivedAt ?? null).toBeNull();
    });
  });
});
