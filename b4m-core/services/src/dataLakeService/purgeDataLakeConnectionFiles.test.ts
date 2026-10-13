import { describe, it, expect, vi } from 'vitest';
import { purgeDataLakeConnectionFiles, type PurgeableConnectionFile } from './purgeDataLakeConnectionFiles';

const SCOPE = { datalakeTag: 'datalake:sales', fileTagPrefix: 'sales', createdByUserId: 'owner-1' } as never;

const file = (id: string, userId: string, fileSize: number, extra: Record<string, unknown> = {}) =>
  ({ id, userId, fileSize, tags: [], ...extra }) as PurgeableConnectionFile;

const makeDb = (files: PurgeableConnectionFile[]) => {
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
    const files = [file('dead', 'owner-1', 200, { deletedAt: new Date() })];
    const db = makeDb(files);

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db: db as never });

    expect(result.filesPurged).toBe(1);
    expect(db.fabFiles.hardDeleteOneById).toHaveBeenCalledWith('dead');
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('refunds only live and archived bytes in a mixed slice, per owner', async () => {
    const files = [
      file('live', 'owner-1', 500),
      file('archived', 'owner-2', 300, { archivedAt: new Date() }),
      file('dead', 'owner-1', 200, { deletedAt: new Date() }),
    ];
    const db = makeDb(files);

    const result = await purgeDataLakeConnectionFiles(SCOPE, files, { db: db as never });

    expect(result.filesPurged).toBe(3);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(2);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-1', -500);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-2', -300);
  });

  it('does not refund again on redelivery', async () => {
    const files = [file('live', 'owner-1', 500)];
    const db = makeDb(files);

    await purgeDataLakeConnectionFiles(SCOPE, files, { db: db as never });
    const second = await purgeDataLakeConnectionFiles(SCOPE, files, { db: db as never });

    expect(second.filesPurged).toBe(0);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(1);
  });
});
