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
    hardDeleteOneById: vi.fn(async () => true),
    findById: vi.fn(async () => undefined as never),
    pullTagsByFabFileId: vi.fn(async () => {}),
  },
  fabFileChunks: {
    deleteManyByFabFileId: vi.fn(async () => {}),
  },
});

/** Records every row/chunk delete as `<kind>:<id>` so both ORDER and PAIRING are assertable. */
const traceDeletes = (db: ReturnType<typeof makeDb>) => {
  const order: string[] = [];
  db.fabFiles.hardDeleteOneById = vi.fn(async (id: string) => {
    order.push(`row:${id}`);
    return true;
  });
  db.fabFileChunks.deleteManyByFabFileId = vi.fn(async (id: string) => {
    order.push(`chunks:${id}`);
  });
  return order;
};

describe('cleanupDeletedDataLake', () => {
  it("hard-deletes each file's row immediately before its own chunks, so an interruption orphans chunks rather than stranding a row (#2583)", async () => {
    const db = makeDb();
    const order = traceDeletes(db);

    // chunkSize:1 makes the fan-out strictly sequential. At the default size `inChunks` runs the
    // slice under Promise.all, so the two files' awaits interleave and the recorded order stops
    // distinguishing pairing from a bulk-then-bulk sweep - which is the exact thing under test.
    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db, chunkSize: 1 });

    // Row-before-its-chunks (#2583): a crash between the two must strand only orphaned chunks -
    // unreachable without their file - never a row reporting a stale vectorizedChunkCount over
    // chunks that no longer exist.
    //
    // Interleaved, NOT ['row:f1','row:f2','chunks:f1','chunks:f2']: the pairing is the retry
    // contract, not a style choice. `fileIds` is derived from the rows, so a bulk row delete
    // followed by a separate chunk fan-out leaves a DLQ replay re-resolving an EMPTY id list and
    // skipping the chunk sweep for the whole lake. Flattening this back would restore that.
    expect(order).toEqual(['row:f1', 'chunks:f1', 'row:f2', 'chunks:f2']);
  });

  it('leaves the ids it has not reached still resolvable when a chunk delete is interrupted, so a DLQ retry resumes (#2583)', async () => {
    const db = makeDb();
    const order = traceDeletes(db);
    db.fabFileChunks.deleteManyByFabFileId = vi.fn(async (id: string) => {
      order.push(`chunks:${id}`);
      if (id === 'f1') throw new Error('simulated crash');
    });

    await expect(cleanupDeletedDataLake(ADMIN, 'lake-1', { db, chunkSize: 1 })).rejects.toThrow('simulated crash');

    // f1's row committed before its chunk delete threw, so f1 leaks orphaned chunks - the harmless
    // direction. f2 was never touched at all: its row survives, so the replay's
    // `findIdsByDataLakeTag` still names it and the sweep resumes there rather than no-opping.
    expect(order).toEqual(['row:f1', 'chunks:f1']);
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalledWith('f2');
  });

  it('is a no-op when the lake is already gone', async () => {
    const db = makeDb();
    db.dataLakes.findById = vi.fn(async () => undefined as never);

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db });

    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
  });
});
