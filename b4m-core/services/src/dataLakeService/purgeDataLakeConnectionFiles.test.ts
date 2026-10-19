import { describe, it, expect, vi } from 'vitest';
import { LegalHoldError, STORAGE_CHARGE_STAMP_CUTOFF } from '@bike4mind/common';
import { purgeDataLakeConnectionFiles, type PurgeableConnectionFile } from './purgeDataLakeConnectionFiles';
import { lakeMembershipScope } from './lakeMembershipScope';

const SCOPE = { kind: 'owned', datalakeTag: 'datalake:sales' } as const;
const CHARGED_AT = new Date('2026-10-10T00:00:00Z');
const BEFORE_STAMP = new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1000);

const file = (overrides: Partial<PurgeableConnectionFile>): PurgeableConnectionFile => ({
  id: 'file-1',
  userId: 'owner-1',
  fileSize: 0,
  createdAt: CHARGED_AT,
  ...overrides,
});

const makeDb = () => ({
  fabFiles: { hardDeleteOneById: vi.fn(async () => true) },
  fabFileChunks: {
    deleteManyByFabFileId: vi.fn(async () => {}),
    clearRetrievalIndexConfirmedByFabFileIds: vi.fn(async () => {}),
  },
  users: { incrementCurrentStorage: vi.fn(async () => {}) },
});

describe('purgeDataLakeConnectionFiles', () => {
  // The refund sums `chargedBytes`, not the raw claimed size: a stamped row and a legacy pre-stamp
  // `complete` row were both charged, a `pending` row that never won the charge was not, and neither
  // was a post-stamp `complete` row (marked uploaded before its event, so still unstamped).
  it('refunds only the charged bytes of the rows it hard-deleted', async () => {
    const db = makeDb();
    const files = [
      file({ id: 'f-stamped', fileSize: 100, storageChargedAt: CHARGED_AT }),
      file({ id: 'f-legacy', fileSize: 200, status: 'complete', createdAt: BEFORE_STAMP }),
      file({ id: 'f-pending', fileSize: 500, status: 'pending', createdAt: CHARGED_AT }),
      file({ id: 'f-late', fileSize: 400, status: 'complete', createdAt: CHARGED_AT }),
    ];

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db });

    expect(result.filesPurged).toBe(4);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(1);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-1', -300);
  });

  it('refunds nothing when none of the hard-deleted rows was charged', async () => {
    const db = makeDb();
    const files = [file({ id: 'f-pending', fileSize: 500, status: 'pending', createdAt: CHARGED_AT })];

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db });

    expect(result.filesPurged).toBe(1);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  // hardDeleteOneById's own return is the gate: a row a concurrent sweep already removed must not
  // refund its owner's bytes a second time.
  it('does not refund a row a concurrent purge already removed', async () => {
    const db = makeDb();
    db.fabFiles.hardDeleteOneById = vi.fn(async () => false);
    const files = [file({ id: 'f-stamped', fileSize: 100, storageChargedAt: CHARGED_AT })];

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db });

    expect(result.filesPurged).toBe(0);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });
  // chargedBytes alone reads a legacy pre-stamp `complete` row as charged even once tombstoned; the
  // deletedAt guard is what keeps its soft-delete refund from being paid a second time here.
  it('refunds nothing for a legacy pre-stamp complete tombstone', async () => {
    const db = makeDb();
    const files = [
      file({ id: 'f-legacy-dead', fileSize: 200, status: 'complete', createdAt: BEFORE_STAMP, deletedAt: new Date() }),
    ];

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db });

    expect(result.filesPurged).toBe(1);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });
});

const LAKE_SCOPE = lakeMembershipScope({
  datalakeTag: 'datalake:sales',
  fileTagPrefix: 'sales',
  createdByUserId: 'owner-1',
});

const lakeFile = (id: string, userId: string, fileSize: number, extra: Record<string, unknown> = {}) =>
  ({ id, userId, fileSize, tags: [], storageChargedAt: new Date(), ...extra }) as PurgeableConnectionFile;

const makeLakeDb = (files: PurgeableConnectionFile[]) => {
  const rows = new Set(files.map(f => f.id));
  return {
    fabFiles: { hardDeleteOneById: vi.fn(async (id: string) => rows.delete(id)) },
    fabFileChunks: {
      deleteManyByFabFileId: vi.fn(async () => {}),
      clearRetrievalIndexConfirmedByFabFileIds: vi.fn(async () => {}),
    },
    users: { incrementCurrentStorage: vi.fn(async () => {}) },
  };
};

describe('purgeDataLakeConnectionFiles storage refund', () => {
  it('hard-deletes a tombstone without refunding it again', async () => {
    const files = [lakeFile('dead', 'owner-1', 200, { deletedAt: new Date() })];
    const db = makeLakeDb(files);

    const result = await purgeDataLakeConnectionFiles(LAKE_SCOPE, files, { db: db as never });

    expect(result.filesPurged).toBe(1);
    expect(db.fabFiles.hardDeleteOneById).toHaveBeenCalledWith('dead');
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('refunds only live and archived bytes in a mixed slice, per owner', async () => {
    const files = [
      lakeFile('live', 'owner-1', 500),
      lakeFile('archived', 'owner-2', 300, { archivedAt: new Date() }),
      lakeFile('dead', 'owner-1', 200, { deletedAt: new Date() }),
    ];
    const db = makeLakeDb(files);

    const result = await purgeDataLakeConnectionFiles(LAKE_SCOPE, files, { db: db as never });

    expect(result.filesPurged).toBe(3);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(2);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-1', -500);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-2', -300);
  });

  it('does not refund again on redelivery', async () => {
    const files = [lakeFile('live', 'owner-1', 500)];
    const db = makeLakeDb(files);

    await purgeDataLakeConnectionFiles(LAKE_SCOPE, files, { db: db as never });
    const second = await purgeDataLakeConnectionFiles(LAKE_SCOPE, files, { db: db as never });

    expect(second.filesPurged).toBe(0);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(1);
  });
});

describe('purgeDataLakeConnectionFiles evidence hold', () => {
  it("keeps an evidence-held file's stored objects while a non-held sibling is purged normally", async () => {
    const files = [
      file({
        id: 'f-held',
        filePath: 'uploads/evidence.png',
        versions: [{ filePath: 'uploads/evidence-v1.png' }] as PurgeableConnectionFile['versions'],
        moderationStatus: 'blocked',
        blockReason: 'explicit',
      }),
      file({ id: 'f-clean', filePath: 'uploads/clean.png' }),
    ];
    const db = makeDb();
    db.fabFiles.hardDeleteOneById = vi.fn(async (id: string) => {
      if (id === 'f-held') {
        throw new LegalHoldError(`Cannot hard-delete FabFile ${id}: moderationStatus is 'blocked' (legal hold)`);
      }
      return true;
    });
    const storage = { delete: vi.fn(async () => {}) };
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db, storage, logger });

    expect(storage.delete.mock.calls).toEqual([['uploads/clean.png']]);
    expect(result).toMatchObject({ filesPurged: 1, storageObjectsDeleted: 1 });
  });

  it("still deletes an unsupported_format block's stored objects, matching the user-delete path", async () => {
    const files = [
      file({
        id: 'f-unscannable',
        filePath: 'uploads/photo.heic',
        moderationStatus: 'blocked',
        blockReason: 'unsupported_format',
      }),
    ];
    const db = makeDb();
    const storage = { delete: vi.fn(async () => {}) };

    await purgeDataLakeConnectionFiles(SCOPE, files, { db, storage });

    expect(storage.delete).toHaveBeenCalledWith('uploads/photo.heic');
  });
});
