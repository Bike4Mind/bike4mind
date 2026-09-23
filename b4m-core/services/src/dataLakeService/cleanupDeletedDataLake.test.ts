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
  dataLakeFindings: {
    deleteForLake: vi.fn(async () => 0),
    deleteForPurgedDocuments: vi.fn(async () => 0),
  },
  dataLakeCorpusActions: {
    deleteForLake: vi.fn(async () => 0),
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
    clearRetrievalIndexConfirmedByFabFileIds: vi.fn(async () => {}),
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

  it('clears the stale residency confirm for every swept file BEFORE the strict index removal, so a sweep aborted between the removal and the chunk hard-delete does not leave a stranded confirm', async () => {
    const order: string[] = [];
    const db = makeDb(['f1', 'f2']);
    db.fabFileChunks.clearRetrievalIndexConfirmedByFabFileIds = vi.fn(async () => {
      order.push('clear');
    });
    const removeForDataLake = vi.fn(async () => {
      order.push('index');
    });

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db, retrievalIndex: { removeForDataLake } });

    expect(order).toEqual(['clear', 'index']);
    expect(db.fabFileChunks.clearRetrievalIndexConfirmedByFabFileIds).toHaveBeenCalledWith(['f1', 'f2']);
  });

  it('aborts the sweep with zero progress when the residency-confirm clear fails, rather than over-claiming', async () => {
    const db = makeDb();
    db.fabFileChunks.clearRetrievalIndexConfirmedByFabFileIds = vi.fn(async () => {
      throw new Error('mongo down');
    });
    const removeForDataLake = vi.fn(async () => {});

    await expect(
      cleanupDeletedDataLake(ADMIN, 'lake-1', { db, retrievalIndex: { removeForDataLake } })
    ).rejects.toThrow('mongo down');

    expect(removeForDataLake).not.toHaveBeenCalled();
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
  });

  it('still aborts the sweep with zero progress when the index removal itself throws, even though the confirm was already cleared', async () => {
    const db = makeDb();
    const removeForDataLake = vi.fn(async () => {
      throw new Error('index down');
    });

    await expect(
      cleanupDeletedDataLake(ADMIN, 'lake-1', { db, retrievalIndex: { removeForDataLake } })
    ).rejects.toThrow('index down');
    expect(db.fabFileChunks.clearRetrievalIndexConfirmedByFabFileIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
  });
  it('cascade-drops the lake findings, whose excerpts would otherwise outlive their corpus', async () => {
    const db = makeDb();

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db });

    // Not just tidiness: a finding stores excerpts of the documents this sweep just hard-deleted,
    // so leaving the rows behind would keep quoting a corpus that no longer exists.
    expect(db.dataLakeFindings.deleteForLake).toHaveBeenCalledWith('lake-1');
  });

  it("cascade-drops the lake's curator corpus-action trail (#3046), before the lake record itself", async () => {
    const db = makeDb();
    const order: string[] = [];
    db.dataLakeCorpusActions.deleteForLake = vi.fn(async () => {
      order.push('corpusActions');
      return 0;
    });
    db.dataLakes.delete = vi.fn(async () => {
      order.push('lake');
    });

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db });

    expect(db.dataLakeCorpusActions.deleteForLake).toHaveBeenCalledWith('lake-1');
    expect(order).toEqual(['corpusActions', 'lake']);
  });

  it("sweeps each destroyed document's findings GLOBALLY, so a co-tagged lake keeps no excerpt of it", async () => {
    const db = makeDb(['f1', 'f2']);

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db });

    // `deleteForLake('lake-1')` above cannot reach this case. A file can carry two lakes' meta-tags
    // - `addFileToLake` has no exclusivity check - and step 2 hard-deletes the FabFile GLOBALLY.
    // Lake B's finding would otherwise survive quoting a 240-char excerpt of a document that no
    // longer exists anywhere, unresolvable by anyone and never re-detectable to be rewritten.
    // One `$in` for the slice, not one round trip per file: the fan-out is already chunked for the
    // Lambda budget, and the sweep is idempotent and independent of whether the row still exists.
    expect(db.dataLakeFindings.deleteForPurgedDocuments).toHaveBeenCalledWith(['f1', 'f2']);
    expect(db.dataLakeFindings.deleteForPurgedDocuments).toHaveBeenCalledTimes(1);
  });

  it('batches the sweep PER SLICE, so a large lake does not pay a round trip per file', async () => {
    // chunkSize:2 over three files gives two slices. Asserting the slices rather than the call
    // count is what catches a regression back to per-id: that shape would call this three times
    // with single-element arrays and still satisfy a naive "was it called" assertion.
    const db = makeDb(['f1', 'f2', 'f3']);

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db, chunkSize: 2 });

    expect(db.dataLakeFindings.deleteForPurgedDocuments.mock.calls).toEqual([[['f1', 'f2']], [['f3']]]);
  });

  it("sweeps a slice's findings BEFORE any of its rows, so an interruption cannot strand them", async () => {
    // Once a row is gone its id is no longer resolvable by `findIdsByDataLakeTag`, so a DLQ retry
    // could never name it again - the findings would be stranded permanently. This order fails the
    // recoverable way instead: findings lost early are still re-detectable from documents that
    // still exist. Two files in ONE slice, so the assertion is that the batch precedes BOTH rows,
    // not merely that it precedes the row it happens to be paired with.
    const db = makeDb(['f1', 'f2']);
    const order: string[] = [];
    db.dataLakeFindings.deleteForPurgedDocuments = vi.fn(async (ids: string[]) => {
      order.push(`findings:${ids.join('+')}`);
      return 0;
    });
    db.fabFiles.hardDeleteOneById = vi.fn(async (id: string) => {
      order.push(`row:${id}`);
      return true;
    });

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db });

    expect(order).toEqual(['findings:f1+f2', 'row:f1', 'row:f2']);
  });

  it('aborts before deleting the lake record when the LAKE-SCOPED findings sweep rejects', async () => {
    // Ordering is the retry door. The lake record is what a DLQ replay re-reads to re-enter the
    // sweep, so deleting it after a failed sweep would strand the rows permanently - nothing left
    // would name the lake. Failing with the lake still present is the recoverable direction.
    const db = makeDb();
    db.dataLakeFindings.deleteForLake = vi.fn(async () => {
      throw new Error('findings sweep failed');
    });

    await expect(cleanupDeletedDataLake(ADMIN, 'lake-1', { db })).rejects.toThrow('findings sweep failed');
    expect(db.dataLakes.delete).not.toHaveBeenCalled();
  });

  it('aborts the slice when the PER-DOCUMENT findings sweep rejects, leaving every id resolvable', async () => {
    // This is the entire reason `deleteForPurgedDocuments` runs BEFORE the slice's rows, and the
    // case the `deleteForLake` test above does NOT cover. Swallow-and-continue here - the natural
    // "don't fail a whole teardown over a findings sweep" reflex - destroys the FabFiles with
    // their findings unswept, and a co-tagged sibling lake is then left quoting a 240-char excerpt
    // of a document that no longer exists, unresolvable and never re-detectable. Rejecting leaves
    // every row in the slice present, so the replay's `findIdsByDataLakeTag` still names them all.
    const db = makeDb(['f1', 'f2']);
    db.dataLakeFindings.deleteForPurgedDocuments = vi.fn(async () => {
      throw new Error('per-document findings sweep failed');
    });

    await expect(cleanupDeletedDataLake(ADMIN, 'lake-1', { db })).rejects.toThrow('per-document findings sweep failed');
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(db.dataLakes.delete).not.toHaveBeenCalled();
  });

  it('still hard-deletes the files when no findings repo is wired, but says so once', async () => {
    // The port is optional (a host that never ran detection has no rows), and reaching it through
    // `?.` must not make the file sweep itself conditional on it. It must not be SILENT either:
    // without the warning an unwired host destroys documents with no sweep and no symptom, which
    // is indistinguishable from a lake that genuinely carried no findings.
    const db = makeDb(['f1', 'f2']);
    const { dataLakeFindings: _unwired, ...dbWithoutFindings } = db;
    const warn = vi.fn();

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db: dbWithoutFindings, logger: { warn } });

    expect(db.fabFiles.hardDeleteOneById).toHaveBeenCalledWith('f1');
    // Once for the teardown, NOT once per destroyed document - a large lake would otherwise emit
    // thousands of lines for a single wiring fact.
    const unwiredWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('no findings repo wired'));
    expect(unwiredWarnings).toHaveLength(1);
  });

  it('stays quiet about the unwired port when the lake had no files to destroy', async () => {
    // Nothing was destroyed, so nothing went unswept. Warning here would train the reader to
    // ignore the line that matters.
    const db = makeDb([]);
    const { dataLakeFindings: _unwired, ...dbWithoutFindings } = db;
    const warn = vi.fn();

    await cleanupDeletedDataLake(ADMIN, 'lake-1', { db: dbWithoutFindings, logger: { warn } });

    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('no findings repo wired'))).toHaveLength(0);
  });
});
