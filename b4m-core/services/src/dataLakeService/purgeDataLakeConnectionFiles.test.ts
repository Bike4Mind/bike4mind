import { describe, it, expect, vi } from 'vitest';
import { STORAGE_CHARGE_STAMP_CUTOFF } from '@bike4mind/common';
import { purgeDataLakeConnectionFiles, type PurgeableConnectionFile } from './purgeDataLakeConnectionFiles';

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
  // `complete` row were both charged, a `pending` row that never won the charge was not.
  it('refunds only the charged bytes of the rows it hard-deleted', async () => {
    const db = makeDb();
    const files = [
      file({ id: 'f-stamped', fileSize: 100, storageChargedAt: CHARGED_AT }),
      file({ id: 'f-legacy', fileSize: 200, status: 'complete', createdAt: BEFORE_STAMP }),
      file({ id: 'f-pending', fileSize: 500, status: 'pending', createdAt: CHARGED_AT }),
    ];

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db });

    expect(result.filesPurged).toBe(3);
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
});
