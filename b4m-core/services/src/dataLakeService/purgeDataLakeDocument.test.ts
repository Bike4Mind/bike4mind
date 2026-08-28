import { describe, it, expect, vi, beforeEach } from 'vitest';
import { purgeDataLakeDocument } from './purgeDataLakeDocument';

const LAKE = {
  id: 'lake-1',
  datalakeTag: 'datalake:sales',
  fileTagPrefix: 'sales',
  createdByUserId: 'owner-1',
};

const FILE = {
  id: 'file-1',
  fileName: 'q3.pdf',
  userId: 'owner-1',
  tags: [{ name: 'datalake:sales', strength: 1 }],
};

const OWNER = { userId: 'owner-1', isAdmin: false };

const makeStorage = () => ({ delete: vi.fn(async () => ({})) });

const makeDb = (fileOverrides: Record<string, unknown> = {}) => {
  const files = new Map<string, unknown>([[FILE.id, { ...FILE, ...fileOverrides }]]);
  let chunkCount = 3;
  return {
    dataLakeAccessGrants: {
      listByLake: vi.fn(async () => [] as never),
    },
    sessions: {
      findAllWithKnowledgeId: vi.fn(async () => [] as never),
      update: vi.fn(async () => ({}) as never),
    },
    dataLakes: {
      findById: vi.fn(async () => ({ ...LAKE }) as never),
      setStats: vi.fn(async () => {}),
      activateIfDraft: vi.fn(async () => {}),
    },
    fabFiles: {
      // No `?? null`: `BaseRepository.findById` really returns `undefined` for a missing row
      // behind its `T | null` cast, and a mock that normalizes it hides an `=== null` check.
      findById: vi.fn(async (id: string) => files.get(id) as never),
      hardDeleteByIds: vi.fn(async (ids: string[]) => {
        ids.forEach(id => files.delete(id));
        return ids;
      }),
      computeDataLakeStats: vi.fn(async () => ({ fileCount: 4, totalSizeBytes: 900 })),
    },
    fabFileChunks: {
      countByFabFileId: vi.fn(async () => chunkCount),
      deleteManyByFabFileId: vi.fn(async () => {
        chunkCount = 0;
      }),
      distinctRetrievalIndexModelsByFabFileIds: vi.fn(async () => ['text-embedding-3-small']),
    },
  };
};

describe('purgeDataLakeDocument', () => {
  beforeEach(() => vi.clearAllMocks());

  it('destroys chunks then the document and verifies both by reading them back', async () => {
    const db = makeDb();
    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() });

    expect(db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledWith('file-1');
    expect(db.fabFiles.hardDeleteByIds).toHaveBeenCalledWith(['file-1']);
    expect(receipt).toMatchObject({
      fabFileId: 'file-1',
      fileName: 'q3.pdf',
      chunksBefore: 3,
      chunksRemaining: 0,
      documentDeleted: true,
      verified: true,
      embeddingModels: ['text-embedding-3-small'],
      fileCount: 4,
      totalSizeBytes: 900,
    });
  });

  it('reports verified:false rather than throwing when the sweep leaves chunks behind', async () => {
    // A receipt is more useful to the caller than an exception: it says WHERE the sweep stopped.
    const db = makeDb();
    db.fabFileChunks.deleteManyByFabFileId = vi.fn(async () => {});
    db.fabFileChunks.countByFabFileId = vi.fn(async () => 3);
    const logger = { info: vi.fn(), error: vi.fn() };

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage(), logger });

    expect(receipt.verified).toBe(false);
    expect(receipt.chunksRemaining).toBe(3);
    expect(logger.error).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('removes the document from a wired retrieval index BEFORE anything destructive', async () => {
    const order: string[] = [];
    const db = makeDb();
    const removeForDataLake = vi.fn(async () => {
      order.push('index');
    });
    db.fabFileChunks.deleteManyByFabFileId = vi.fn(async () => {
      order.push('chunks');
    });

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', {
      db,
      retrievalIndex: { removeForDataLake },
    });

    expect(order).toEqual(['index', 'chunks']);
    expect(removeForDataLake).toHaveBeenCalledWith({
      scope: { datalakeTag: 'datalake:sales', fileTagPrefix: 'sales', creatorUserId: 'owner-1' },
      fabFileIds: ['file-1'],
    });
    expect(receipt.retrievalIndexOutcome).toBe('purged');
  });

  it('makes a failing retrieval index abort before any data is destroyed', async () => {
    const db = makeDb();
    const retrievalIndex = {
      removeForDataLake: vi.fn(async () => {
        throw new Error('index down');
      }),
    };

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage(), retrievalIndex })).rejects.toThrow(
      'index down'
    );
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('refuses a caller who is neither the lake owner nor an admin', async () => {
    const db = makeDb();
    await expect(
      purgeDataLakeDocument({ userId: 'someone-else', isAdmin: false }, 'lake-1', 'file-1', { db, storage: makeStorage() })
    ).rejects.toThrow(/Only the owner/);
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('follows an ownership transfer: the owner grant destroys, the demoted creator cannot', async () => {
    // The rung that matters most here. `createdByUserId` never moves, so a creator-only gate would
    // lock out the new owner and leave the right with the person ownership was taken from.
    const withTransfer = (fileUserId = 'owner-1') => {
      const db = makeDb({ userId: fileUserId });
      db.dataLakeAccessGrants.listByLake = vi.fn(async () => [
        { principalType: 'user', principalId: 'new-owner', role: 'owner' },
      ]) as never;
      return db;
    };

    const granted = withTransfer('new-owner');
    const receipt = await purgeDataLakeDocument({ userId: 'new-owner', isAdmin: false }, 'lake-1', 'file-1', {
      db: granted,
      storage: makeStorage(),
    });
    expect(receipt.verified).toBe(true);

    const demoted = withTransfer();
    await expect(
      purgeDataLakeDocument({ userId: 'owner-1', isAdmin: false }, 'lake-1', 'file-1', { db: demoted, storage: makeStorage() })
    ).rejects.toThrow(/Only the owner/);
    expect(demoted.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('refuses an admin of the lake\'s organization - the org rung manages, it does not destroy', async () => {
    // The route threads `administeredOrgIds` through, so the rule is what decides, not the wiring.
    const db = makeDb();
    db.dataLakes.findById = vi.fn(async () => ({ ...LAKE, organizationId: 'org-1' }) as never);

    await expect(
      purgeDataLakeDocument({ userId: 'org-admin-1', isAdmin: false, administeredOrgIds: ['org-1'] }, 'lake-1', 'file-1', {
        db,
        storage: makeStorage(),
      })
    ).rejects.toThrow(/Only the owner/);
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('refuses a curator grant - managing membership is not destroying content', async () => {
    const db = makeDb();
    db.dataLakeAccessGrants.listByLake = vi.fn(async () => [
      { principalType: 'user', principalId: 'curator-1', role: 'curator' },
    ]) as never;

    await expect(
      purgeDataLakeDocument({ userId: 'curator-1', isAdmin: false }, 'lake-1', 'file-1', { db, storage: makeStorage() })
    ).rejects.toThrow(/Only the owner/);
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('unlinks the destroyed document from every chat that referenced it', async () => {
    const db = makeDb();
    db.sessions.findAllWithKnowledgeId = vi.fn(async () => [
      { id: 'session-1', knowledgeIds: ['file-1', 'other-file'] },
      { id: 'session-2', knowledgeIds: ['file-1'] },
    ]) as never;

    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() });

    expect(db.sessions.update).toHaveBeenCalledWith({ id: 'session-1', knowledgeIds: ['other-file'] });
    expect(db.sessions.update).toHaveBeenCalledWith({ id: 'session-2', knowledgeIds: [] });
  });

  it('hands the owner, the bytes and the pre-delete tags to onPurged', async () => {
    // The caller's half of the cleanup: the storage quota to return, and the OTHER lakes whose
    // stats this service cannot reach. Both need values that no longer exist after the writes.
    const db = makeDb();
    db.fabFiles.findById = vi.fn(async (id: string) =>
      id === 'file-1'
        ? ({
            ...FILE,
            filePath: 'uploads/q3.pdf',
            fileSize: 27707,
            tags: [
              { name: 'datalake:sales', strength: 1 },
              { name: 'datalake:archive', strength: 1 },
            ],
          } as never)
        : (undefined as never)
    );
    const onPurged = vi.fn(async () => {});

    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage(), onPurged });

    expect(onPurged).toHaveBeenCalledWith({
      ownerUserId: 'owner-1',
      fileSize: 27707,
      tagNames: ['datalake:sales', 'datalake:archive'],
    });
  });

  it('reports no bytes to return for a row that never stored an object', async () => {
    const db = makeDb();
    const onPurged = vi.fn(async () => {});
    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage(), onPurged });
    expect(onPurged).toHaveBeenCalledWith(expect.objectContaining({ fileSize: 0 }));
  });

  it('keeps the receipt to its declared fields, so recomputeLakeStats extras cannot ride along', async () => {
    const db = makeDb();
    db.fabFiles.computeDataLakeStats = vi.fn(async () => ({
      fileCount: 4,
      totalSizeBytes: 900,
      totalChunkedChars: 29262,
    })) as never;

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() });

    expect(receipt).not.toHaveProperty('totalChunkedChars');
  });

  it('404s on a file the lake does not admit, instead of destroying it', async () => {
    const db = makeDb();
    // Owned by the creator but carrying neither the meta-tag nor a prefixed tag.
    db.fabFiles.findById = vi.fn(async () => ({ ...FILE, tags: [{ name: 'personal', strength: 1 }] }));

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() })).rejects.toThrow(
      'File not found in this data lake'
    );
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('does not admit a prefixed tag on a file the LAKE CREATOR does not own', async () => {
    // Mirrors the read path's ownership conjunct: a stranger's file matching the prefix was never
    // a member, so permanent deletion must not reach it either.
    const db = makeDb();
    db.fabFiles.findById = vi.fn(async () => ({
      ...FILE,
      userId: 'stranger',
      tags: [{ name: 'sales/q3', strength: 1 }],
    }));

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() })).rejects.toThrow(
      'File not found in this data lake'
    );
  });

  it('404s when the lake itself is gone', async () => {
    const db = makeDb();
    db.dataLakes.findById = vi.fn(async () => undefined as never);
    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() })).rejects.toThrow('Data lake not found');
  });

  it('refuses a lake owner destroying a contributor\'s document, and destroys nothing', async () => {
    // The lake is the authorization scope, not a licence over other people's files: the meta-tag
    // membership arm admits a contributor's own upload, and this destruction is global.
    const db = makeDb({ userId: 'contributor-1' });

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() })).rejects.toThrow(
      /Only the file's owner/
    );
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('lets a platform admin destroy a document they do not own', async () => {
    const db = makeDb({ userId: 'contributor-1' });

    const receipt = await purgeDataLakeDocument({ userId: 'admin-1', isAdmin: true }, 'lake-1', 'file-1', {
      db,
      storage: makeStorage(),
    });

    expect(receipt.verified).toBe(true);
  });

  it('reports documentDeleted:false when the row survives the delete', async () => {
    // The direction the shipped `=== null` bug lived in: without this the field could be hardcoded
    // true and every assertion in the file would still pass.
    const db = makeDb();
    db.fabFiles.hardDeleteByIds = vi.fn(async (ids: string[]) => ids);

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() });

    expect(receipt.documentDeleted).toBe(false);
    expect(receipt.verified).toBe(false);
  });

  it('deletes the stored object, and only then offers its bytes back', async () => {
    const db = makeDb({ filePath: 'uploads/q3.pdf', fileSize: 27707 });
    const storage = makeStorage();
    const onPurged = vi.fn(async () => {});

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage, onPurged });

    expect(storage.delete).toHaveBeenCalledWith('uploads/q3.pdf');
    expect(receipt.storageObjectDeleted).toBe(true);
    expect(onPurged).toHaveBeenCalledWith(expect.objectContaining({ fileSize: 27707 }));
  });

  it('withholds the quota refund when the stored object could not be deleted', async () => {
    // Refunding bytes that are still held drifts the owner's quota permissively, and the row that
    // named the object is already gone - so the receipt has to say so instead.
    const db = makeDb({ filePath: 'uploads/q3.pdf', fileSize: 27707 });
    const storage = { delete: vi.fn(async () => Promise.reject(new Error('s3 down'))) };
    const onPurged = vi.fn(async () => {});
    const logger = { info: vi.fn(), error: vi.fn() };

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage, onPurged, logger });

    expect(receipt.storageObjectDeleted).toBe(false);
    expect(onPurged).toHaveBeenCalledWith(expect.objectContaining({ fileSize: 0 }));
    expect(logger.error).toHaveBeenCalled();
    // Non-fatal: the document itself really is gone, and the receipt is the record of both facts.
    expect(receipt.verified).toBe(true);
  });

  it('distinguishes collocated vectors from a door left unwired', async () => {
    const collocated = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', {
      db: makeDb(),
      storage: makeStorage(),
      vectorsCollocated: true,
    });
    expect(collocated.retrievalIndexOutcome).toBe('collocated');

    const unwired = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', {
      db: makeDb(),
      storage: makeStorage(),
    });
    expect(unwired.retrievalIndexOutcome).toBe('unwired');
  });

  it('files the receipt through onReceipt before the best-effort bookkeeping runs', async () => {
    // Ordering is the point: onPurged is best-effort and may throw, and an irreversible
    // destruction must not lose its durable record to a failure in the cleanup that follows it.
    const order: string[] = [];
    const receipts: unknown[] = [];

    await expect(
      purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', {
        db: makeDb(),
        storage: makeStorage(),
        onReceipt: async receipt => {
          order.push('receipt');
          receipts.push(receipt);
        },
        onPurged: async () => {
          order.push('purged');
          throw new Error('stats rebuild failed');
        },
      })
    ).rejects.toThrow('stats rebuild failed');

    expect(order).toEqual(['receipt', 'purged']);
    expect(receipts[0]).toMatchObject({ fabFileId: 'file-1', verified: true });
  });

  it('recomputes the lake stats so the caller does not need a second round trip', async () => {
    const db = makeDb();
    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() });
    expect(db.dataLakes.setStats).toHaveBeenCalledWith('lake-1', { fileCount: 4, totalSizeBytes: 900 });
  });
});
