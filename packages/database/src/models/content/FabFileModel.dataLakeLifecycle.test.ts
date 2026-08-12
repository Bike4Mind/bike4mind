import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, type DataLakeMembershipScope } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
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
      });
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
  });

  // #1040: the single-lake browse (fabFileRepository.search with lakeMembership +
  // restrictToDataLake, what GET /api/data-lakes/:id/articles runs) must agree with
  // computeDataLakeStats above about who is a member - a file only reached through a share or a
  // group grant is excluded from the listing itself, not merely from the count, so it can never
  // be "listed but unremovable".
  describe('search under a single-lake browse scope (lakeMembership)', () => {
    const pagination = { page: 1, limit: 20 };
    const order = { by: 'fileName', direction: 'asc' } as const;

    it('lists exactly the members computeDataLakeStats counts, excluding every stranger-owned prefix match', async () => {
      const rows = await seedLakeRows();

      const result = await fabFileRepository.search(CREATOR, '', {}, pagination, order, {
        includeShared: true,
        userGroups: [CREATOR_GROUP],
        lakeMembership: scope,
        restrictToDataLake: true,
      });

      expect(result.data.map(f => f.fileName).sort()).toEqual(['meta.txt', 'prefix-owned.txt']);
      const listedIds = result.data.map(f => f.id);
      for (const id of rows.strangerIds) {
        expect(listedIds).not.toContain(id);
      }
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

    it('restores everything it archived, so no member is stranded', async () => {
      const rows = await seedLakeRows();

      await fabFileRepository.archiveByDataLakeTag(scope);
      const restored = await fabFileRepository.unarchiveByDataLakeTag(scope);

      expect(restored).toBe(2);
      for (const id of rows.memberIds) {
        expect((await readRaw(id))?.archivedAt ?? null).toBeNull();
      }
    });

    it('finds archived members for the unarchive dedup pass', async () => {
      await seedLakeRows();
      await fabFileRepository.archiveByDataLakeTag(scope);

      const found = await fabFileRepository.findArchivedByDataLakeTag(scope);

      expect(found.map(f => f.fileName).sort()).toEqual(['meta.txt', 'prefix-owned.txt']);
    });

    it('hasArchivedByDataLakeTag reports existence without materializing the rows', async () => {
      await seedLakeRows();

      expect(await fabFileRepository.hasArchivedByDataLakeTag(scope)).toBe(false);

      await fabFileRepository.archiveByDataLakeTag(scope);

      expect(await fabFileRepository.hasArchivedByDataLakeTag(scope)).toBe(true);
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
