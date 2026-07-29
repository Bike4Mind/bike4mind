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
  creatorGroupIds: [CREATOR_GROUP],
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
 * Four rows spanning every membership signal, plus the row that must never be touched.
 * `hostile` is prefix-tagged but owned by an unrelated user with no share to the creator:
 * `fileTagPrefix` has no uniqueness constraint, so without the creator-access conjunct a
 * whole-lake write would reach into a stranger's files.
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
  const prefixSharedToCreator = await makeFile({
    fileName: 'prefix-shared.txt',
    userId: STRANGER,
    tags: [{ name: 'acme:shared' }],
    users: [{ userId: CREATOR, permissions: ['read'] }],
  });
  const prefixSharedToCreatorGroup = await makeFile({
    fileName: 'prefix-group.txt',
    userId: STRANGER,
    tags: [{ name: 'acme:group' }],
    groups: [{ groupId: CREATOR_GROUP, permissions: ['read'] }],
  });
  const hostile = await makeFile({
    fileName: 'hostile.txt',
    userId: STRANGER,
    tags: [{ name: 'acme:not-yours' }],
  });

  return {
    metaTagged,
    prefixOwned,
    prefixSharedToCreator,
    prefixSharedToCreatorGroup,
    hostile,
    memberIds: [metaTagged, prefixOwned, prefixSharedToCreator, prefixSharedToCreatorGroup].map(f => f._id.toString()),
  };
}

const readRaw = async (id: string) => FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

describe('FabFile data lake lifecycle membership', () => {
  describe('computeDataLakeStats', () => {
    it('counts every member signal and excludes the stranger-owned prefix match', async () => {
      await seedLakeRows();

      const stats = await fabFileRepository.computeDataLakeStats(scope);

      expect(stats.fileCount).toBe(4);
      expect(stats.totalSizeBytes).toBe(400);
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

      expect((await fabFileRepository.computeDataLakeStats(scope)).fileCount).toBe(2);
    });
  });

  describe('archiveByDataLakeTag / unarchiveByDataLakeTag', () => {
    it('archives every member and leaves the stranger-owned prefix match live', async () => {
      const rows = await seedLakeRows();

      const archived = await fabFileRepository.archiveByDataLakeTag(scope);

      expect(archived).toBe(4);
      for (const id of rows.memberIds) {
        expect((await readRaw(id))?.archivedAt).not.toBeNull();
      }
      const hostile = await readRaw(rows.hostile._id.toString());
      expect(hostile?.archivedAt ?? null).toBeNull();
      expect(hostile?.deletedAt ?? null).toBeNull();
    });

    it('restores everything it archived, so no member is stranded', async () => {
      const rows = await seedLakeRows();

      await fabFileRepository.archiveByDataLakeTag(scope);
      const restored = await fabFileRepository.unarchiveByDataLakeTag(scope);

      expect(restored).toBe(4);
      for (const id of rows.memberIds) {
        expect((await readRaw(id))?.archivedAt ?? null).toBeNull();
      }
    });

    it('finds archived members for the unarchive dedup pass', async () => {
      await seedLakeRows();
      await fabFileRepository.archiveByDataLakeTag(scope);

      const found = await fabFileRepository.findArchivedByDataLakeTag(scope);

      expect(found.map(f => f.fileName).sort()).toEqual([
        'meta.txt',
        'prefix-group.txt',
        'prefix-owned.txt',
        'prefix-shared.txt',
      ]);
    });
  });

  describe('softDeleteByDataLakeTag / undeleteByDataLakeTag', () => {
    it('soft-deletes every member and spares the stranger-owned prefix match', async () => {
      const rows = await seedLakeRows();

      const ids = await fabFileRepository.softDeleteByDataLakeTag(scope);

      expect(ids.sort()).toEqual([...rows.memberIds].sort());
      expect((await readRaw(rows.hostile._id.toString()))?.deletedAt ?? null).toBeNull();
    });

    it('round-trips a prefix-only member back to live', async () => {
      const rows = await seedLakeRows();

      await fabFileRepository.softDeleteByDataLakeTag(scope);
      const restored = await fabFileRepository.undeleteByDataLakeTag(scope);

      expect(restored).toBe(4);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.deletedAt ?? null).toBeNull();
    });

    it('honours excludeIds so a discarded duplicate stays deleted', async () => {
      const rows = await seedLakeRows();
      await fabFileRepository.softDeleteByDataLakeTag(scope);

      const restored = await fabFileRepository.undeleteByDataLakeTag(scope, [rows.prefixOwned._id.toString()]);

      expect(restored).toBe(3);
      expect((await readRaw(rows.prefixOwned._id.toString()))?.deletedAt).not.toBeNull();
    });

    it('finds soft-deleted members for the restore dedup pass', async () => {
      await seedLakeRows();
      await fabFileRepository.softDeleteByDataLakeTag(scope);

      const found = await fabFileRepository.findDeletedByDataLakeTag(scope);

      expect(found).toHaveLength(4);
    });
  });

  describe('findIdsByDataLakeTag / hardDeleteByDataLakeTag', () => {
    it('reports every member id including soft-deleted ones, for the chunk sweep', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.prefixOwned._id }, { $set: { deletedAt: new Date() } });

      const ids = await fabFileRepository.findIdsByDataLakeTag(scope);

      expect(ids.sort()).toEqual([...rows.memberIds].sort());
      expect(ids).not.toContain(rows.hostile._id.toString());
    });

    it('purges every member and leaves the stranger-owned prefix match intact', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.prefixSharedToCreator._id }, { $set: { deletedAt: new Date() } });

      const purged = await fabFileRepository.hardDeleteByDataLakeTag(scope);

      expect(purged.sort()).toEqual([...rows.memberIds].sort());
      for (const id of rows.memberIds) {
        expect(await readRaw(id)).toBeNull();
      }
      // The row that must survive: a permanent delete of one lake cannot destroy the files of
      // an unrelated user who happens to use the same tag prefix.
      expect(await readRaw(rows.hostile._id.toString())).not.toBeNull();
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
