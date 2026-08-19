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

const makeDb = () => {
  const files = new Map<string, unknown>([[FILE.id, { ...FILE }]]);
  let chunkCount = 3;
  return {
    dataLakes: {
      findById: vi.fn(async () => ({ ...LAKE }) as never),
      setStats: vi.fn(async () => {}),
      activateIfDraft: vi.fn(async () => {}),
    },
    fabFiles: {
      findById: vi.fn(async (id: string) => (files.get(id) ?? null) as never),
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
      distinctEmbeddingModelsByFabFileIds: vi.fn(async () => ['text-embedding-3-small']),
    },
  };
};

describe('purgeDataLakeDocument', () => {
  beforeEach(() => vi.clearAllMocks());

  it('destroys chunks then the document and verifies both by reading them back', async () => {
    const db = makeDb();
    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db });

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

    const receipt = await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, logger });

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
    expect(receipt.retrievalIndexPurged).toBe(true);
  });

  it('makes a failing retrieval index abort before any data is destroyed', async () => {
    const db = makeDb();
    const retrievalIndex = {
      removeForDataLake: vi.fn(async () => {
        throw new Error('index down');
      }),
    };

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db, retrievalIndex })).rejects.toThrow(
      'index down'
    );
    expect(db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('refuses a caller who is neither the lake creator nor an admin', async () => {
    const db = makeDb();
    await expect(
      purgeDataLakeDocument({ userId: 'someone-else', isAdmin: false }, 'lake-1', 'file-1', { db })
    ).rejects.toThrow(/Only the creator/);
    expect(db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
  });

  it('404s on a file the lake does not admit, instead of destroying it', async () => {
    const db = makeDb();
    // Owned by the creator but carrying neither the meta-tag nor a prefixed tag.
    db.fabFiles.findById = vi.fn(async () => ({ ...FILE, tags: [{ name: 'personal', strength: 1 }] }));

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db })).rejects.toThrow(
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

    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db })).rejects.toThrow(
      'File not found in this data lake'
    );
  });

  it('404s when the lake itself is gone', async () => {
    const db = makeDb();
    db.dataLakes.findById = vi.fn(async () => null);
    await expect(purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db })).rejects.toThrow('Data lake not found');
  });

  it('recomputes the lake stats so the caller does not need a second round trip', async () => {
    const db = makeDb();
    await purgeDataLakeDocument(OWNER, 'lake-1', 'file-1', { db });
    expect(db.dataLakes.setStats).toHaveBeenCalledWith('lake-1', { fileCount: 4, totalSizeBytes: 900 });
  });
});
