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
      hardDeleteOneById: vi.fn(async (id: string) => files.delete(id)),
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
    expect(db.fabFiles.hardDeleteOneById).toHaveBeenCalledWith('file-1');
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
      storage: makeStorage(),
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

    await expect(
      purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage(), retrievalIndex })
    ).rejects.toThrow('index down');
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
  });

  it('refuses a caller who is neither the lake owner nor an admin', async () => {
    const db = makeDb();
    await expect(
      purgeDataLakeDocument({ userId: 'someone-else', isAdmin: false }, 'lake-1', 'file-1', {
        db,
        storage: makeStorage(),
      })
    ).rejects.toThrow(/Only the owner/);
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
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
      purgeDataLakeDocument({ userId: 'owner-1', isAdmin: false }, 'lake-1', 'file-1', {
        db: demoted,
        storage: makeStorage(),
      })
    ).rejects.toThrow(/Only the owner/);
    expect(demoted.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
  });

  it("refuses an admin of the lake's organization - the org rung manages, it does not destroy", async () => {
    // The route threads `administeredOrgIds` through, so the rule is what decides, not the wiring.
    const db = makeDb();
    db.dataLakes.findById = vi.fn(async () => ({ ...LAKE, organizationId: 'org-1' }) as never);

    await expect(
      purgeDataLakeDocument(
        { userId: 'org-admin-1', isAdmin: false, administeredOrgIds: ['org-1'] },
        'lake-1',
        'file-1',
        {
          db,
          storage: makeStorage(),
        }
      )
    ).rejects.toThrow(/Only the owner/);
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
  });

  it('refuses a curator grant - managing membership is not destroying content', async () => {
    const db = makeDb();
    db.dataLakeAccessGrants.listByLake = vi.fn(async () => [
      { principalType: 'user', principalId: 'curator-1', role: 'curator' },
    ]) as never;

    await expect(
      purgeDataLakeDocument({ userId: 'curator-1', isAdmin: false }, 'lake-1', 'file-1', { db, storage: makeStorage() })
    ).rejects.toThrow(/Only the owner/);
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
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

  it('drops a non-string tag name rather than handing it to the caller', async () => {
    // `tags` is `[Object]` on FabFileSchema, so Mongoose casts nothing and a malformed name really
    // can be stored. A truthiness filter would pass it through to a caller that case-folds it, and
    // that TypeError lands AFTER the document is already destroyed.
    const db = makeDb();
    db.fabFiles.findById = vi.fn(async (id: string) =>
      id === 'file-1'
        ? ({
            ...FILE,
            tags: [
              { name: 'datalake:sales', strength: 1 },
              { name: 42, strength: 1 },
            ],
          } as never)
        : (undefined as never)
    );
    const onPurged = vi.fn(async () => {});

    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage(), onPurged });

    expect(onPurged).toHaveBeenCalledWith(expect.objectContaining({ tagNames: ['datalake:sales'] }));
  });

  it('logs the filePath when a stored object cannot be removed, so the orphan can be found', async () => {
    const db = makeDb({ filePath: 'uploads/q3.pdf', fileSize: 27707 });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const storage = {
      delete: vi.fn(async () => {
        throw new Error('s3 down');
      }),
    };

    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage, logger });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not remove a stored object'),
      expect.objectContaining({ filePath: 'uploads/q3.pdf' })
    );
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
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
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
    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() })).rejects.toThrow(
      'Data lake not found'
    );
  });

  it("refuses a lake owner destroying a contributor's document, and destroys nothing", async () => {
    // The lake is the authorization scope, not a licence over other people's files: the meta-tag
    // membership arm admits a contributor's own upload, and this destruction is global.
    const db = makeDb({ userId: 'contributor-1' });

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage() })).rejects.toThrow(
      /Only the file's owner/
    );
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
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
    db.fabFiles.hardDeleteOneById = vi.fn(async () => false);

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

  it('keeps the row when a stored object survives, so a retry can still name the bytes', async () => {
    // The row is the ONLY thing carrying filePath. Destroying it while the object is still stored
    // strands the bytes with nothing able to name them, so the sweep stops short and says so.
    const db = makeDb({ filePath: 'uploads/q3.pdf', fileSize: 27707 });
    const storage = { delete: vi.fn(async () => Promise.reject(new Error('s3 down'))) };
    const onPurged = vi.fn(async () => {});
    const logger = { info: vi.fn(), error: vi.fn() };

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage, onPurged, logger });

    expect(receipt.storageObjectDeleted).toBe(false);
    expect(receipt.storageObjectsRemaining).toBe(1);
    // Chunks (and the rollups they carry) survive too: a partial sweep must not leave the row's
    // health rollups stale relative to chunks that no longer exist.
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(receipt.chunksRemaining).toBe(receipt.chunksBefore);
    expect(db.fabFiles.hardDeleteOneById).not.toHaveBeenCalled();
    expect(db.sessions.findAllWithKnowledgeId).not.toHaveBeenCalled();
    expect(receipt.documentDeleted).toBe(false);
    expect(receipt.verified).toBe(false);
    expect(onPurged).toHaveBeenCalledWith(expect.objectContaining({ fileSize: 0 }));
    expect(logger.error).toHaveBeenCalled();
  });

  it('deletes every prior version object, not just the current filePath', async () => {
    // An AI-edited file keeps each earlier revision under its own key; `filePath` names only the
    // newest, so deleting that alone leaves the original document's bytes stored forever.
    const db = makeDb({
      filePath: 'uploads/q3-v2.pdf',
      fileSize: 27707,
      versions: [
        { version: 1, filePath: 'uploads/q3.pdf' },
        { version: 2, filePath: 'uploads/q3-v2.pdf' },
      ],
    });
    const storage = makeStorage();

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage });

    expect(storage.delete.mock.calls.map(c => c[0]).sort()).toEqual(['uploads/q3-v2.pdf', 'uploads/q3.pdf']);
    // Deduped: the current key is also the newest version's key.
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(receipt.storageObjectsTotal).toBe(2);
    expect(receipt.storageObjectDeleted).toBe(true);
  });

  it('withholds the refund when a concurrent purge removed the row first', async () => {
    // Deleting an already-absent object key succeeds, so without the atomic claim both callers
    // would refund the same bytes and halve the owner's recorded storage.
    const db = makeDb({ filePath: 'uploads/q3.pdf', fileSize: 27707 });
    // The other request won the claim: the row is already gone by the time this delete runs.
    db.fabFiles.hardDeleteOneById = vi.fn(async () => false);
    const onPurged = vi.fn(async () => {});

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, storage: makeStorage(), onPurged });

    expect(receipt.storageObjectDeleted).toBe(true);
    expect(onPurged).toHaveBeenCalledWith(expect.objectContaining({ fileSize: 0 }));
  });

  it('shreds the facts extracted from the document, only once the destruction converged', async () => {
    const shredDocumentMemory = vi.fn(async () => {});

    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', {
      db: makeDb(),
      storage: makeStorage(),
      shredDocumentMemory,
    });

    expect(shredDocumentMemory).toHaveBeenCalledWith({
      datalakeTag: 'datalake:sales',
      ownerUserId: 'owner-1',
      fabFileId: 'file-1',
    });
  });

  it('leaves the extracted facts alone when the sweep did not converge', async () => {
    // Shredding the beliefs of a document that survived would destroy recall for content the lake
    // still holds.
    const db = makeDb();
    db.fabFileChunks.deleteManyByFabFileId = vi.fn(async () => {});
    const shredDocumentMemory = vi.fn(async () => {});

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', {
      db,
      storage: makeStorage(),
      shredDocumentMemory,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(receipt.verified).toBe(false);
    expect(shredDocumentMemory).not.toHaveBeenCalled();
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
