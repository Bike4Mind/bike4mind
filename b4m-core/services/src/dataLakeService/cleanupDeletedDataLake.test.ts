import { describe, it, expect, vi } from 'vitest';
import { cleanupDeletedDataLake } from './cleanupDeletedDataLake';

const LAKE = {
  id: 'lake-1',
  datalakeTag: 'datalake:sales',
  fileTagPrefix: 'sales',
  createdByUserId: 'owner-1',
  organizationId: undefined,
  status: 'purging' as const,
};

// isAdmin:true short-circuits canManageLake, so the grant lookup below only needs to resolve, not
// to carry a real grant.
const ADMIN = { userId: 'admin-1', isAdmin: true };

const makeDb = (fileIds: string[] = ['f1', 'f2']) => ({
  dataLakes: {
    findById: vi.fn(async () => ({ ...LAKE })),
    delete: vi.fn(async () => {}),
    find: vi.fn(async () => [] as never),
  },
  dataLakeAccessGrants: {
    listByLake: vi.fn(async () => [] as never),
    removeAllForLake: vi.fn(async () => {}),
  },
  batches: {
    find: vi.fn(async () => [] as never),
    delete: vi.fn(async () => {}),
  },
  fabFiles: {
    // Called twice: the main sweep, then the mid-sweep-joiner re-check (step 3b). A real DB would
    // find nothing left the second time once the ids above are hard-deleted; the mock mirrors that
    // rather than replaying the same ids forever.
    findIdsByDataLakeTag: vi
      .fn()
      .mockResolvedValueOnce(fileIds)
      .mockResolvedValue([] as never),
    hardDeleteByIds: vi.fn(async (ids: string[]) => ids),
    findById: vi.fn(async () => undefined as never),
    pullTagsByFabFileId: vi.fn(async () => {}),
  },
  fabFileChunks: {
    deleteManyByFabFileId: vi.fn(async () => {}),
  },
});

describe('cleanupDeletedDataLake', () => {
  it('hard-deletes the file rows before deleting their chunks, so an interruption orphans chunks rather than stranding a row (#2583)', async () => {
    const order: string[] = [];
    const db = makeDb();
    db.fabFiles.hardDeleteByIds = vi.fn(async (ids: string[]) => {
      order.push('files');
      return ids;
    });
    db.fabFileChunks.deleteManyByFabFileId = vi.fn(async () => {
      order.push('chunks');
    });

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db });

    // The rows go first (#2583): a crash between the two steps must strand only orphaned chunks -
    // unreachable without their file, and already a tracked, separately cleanable class (#2539) -
    // never a row reporting a stale vectorizedChunkCount over chunks that no longer exist.
    expect(order).toEqual(['files', 'chunks', 'chunks']);
    expect(db.fabFiles.hardDeleteByIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledWith('f1');
    expect(db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledWith('f2');
  });

  it('leaves the file rows already gone, not stranded with stale rollups, when the chunk delete is interrupted (#2583)', async () => {
    const db = makeDb();
    db.fabFileChunks.deleteManyByFabFileId = vi.fn(async () => {
      throw new Error('simulated crash');
    });

    await expect(cleanupDeletedDataLake(ADMIN, 'lake-1', { db })).rejects.toThrow('simulated crash');

    // The hard-delete already committed by the time the chunk delete threw.
    expect(db.fabFiles.hardDeleteByIds).toHaveBeenCalledWith(['f1', 'f2']);
  });

  it('is a no-op when the lake is already gone', async () => {
    const db = makeDb();
    db.dataLakes.findById = vi.fn(async () => undefined as never);

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db });

    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });
});
