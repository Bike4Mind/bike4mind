import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
