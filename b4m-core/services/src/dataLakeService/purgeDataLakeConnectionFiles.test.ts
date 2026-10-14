import { describe, it, expect, vi, beforeEach } from 'vitest';
import { purgeDataLakeConnectionFiles, type PurgeableConnectionFile } from './purgeDataLakeConnectionFiles';

/**
 * The refund gate is the whole point of this suite: a connection-scoped purge reaches rows the
 * user already soft-deleted (its finder is `includeDeleted`-blind by design, so an archived lake's
 * members are still reached), and a soft delete already refunded them. Refunding again debits the
 * owner a second time. Rows are still hard-deleted either way - that half is asserted here too, so
 * a "fix" that skipped tombstones entirely would fail rather than pass quietly.
 */

const SCOPE = { kind: 'owned' as const, datalakeTag: 'datalake:drive', createdByUserId: 'owner-1' };

/** `archivedAt` is not part of the sweep's input, but a live archived row carries it - see the archived-arm test. */
type TestFile = PurgeableConnectionFile & { archivedAt?: Date };

const file = (over: Partial<TestFile> = {}): TestFile => ({
  id: 'f1',
  userId: 'owner-1',
  fileSize: 100,
  filePath: 'files/f1',
  versions: [],
  tags: [{ name: 'datalake:drive', strength: 1 }],
  ...over,
});

const makeDb = () => ({
  fabFiles: { hardDeleteOneById: vi.fn(async () => true) },
  fabFileChunks: {
    deleteManyByFabFileId: vi.fn(async () => undefined),
    clearRetrievalIndexConfirmedByFabFileIds: vi.fn(async () => undefined),
  },
  users: { incrementCurrentStorage: vi.fn(async () => undefined) },
  dataLakeFindings: { deleteForPurgedDocuments: vi.fn(async () => 0) },
  sessions: { pullKnowledgeIds: vi.fn(async () => undefined) },
});

const storage = () => ({ delete: vi.fn(async () => ({})) });

describe('purgeDataLakeConnectionFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hard-deletes a soft-deleted row but does NOT refund it again', async () => {
    const db = makeDb();
    const tombstone = file({ deletedAt: new Date() });
    const shredDocumentMemory = vi.fn(async () => {});

    const result = await purgeDataLakeConnectionFiles(SCOPE, [tombstone], {
      db,
      storage: storage(),
      shredDocumentMemory,
    });

    expect(db.fabFiles.hardDeleteOneById).toHaveBeenCalledWith('f1');
    // The bug: this used to refund the tombstone a second time.
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
    // ...but the row is still removed, so filesPurged keeps its documented meaning.
    expect(result.filesPurged).toBe(1);
    // The tombstone's every other cleanup half still runs - only the refund is skipped.
    expect(shredDocumentMemory).toHaveBeenCalledWith({
      tagNames: ['datalake:drive'],
      fabFileId: 'f1',
      ownerUserId: 'owner-1',
    });
    expect(db.sessions.pullKnowledgeIds).toHaveBeenCalledWith(['f1']);
    expect(db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledWith('f1');
  });

  it('still refunds a live archived row exactly once (archivedAt is not a tombstone)', async () => {
    const db = makeDb();
    const archived = file({ id: 'f-archived', fileSize: 250, archivedAt: new Date() });

    const result = await purgeDataLakeConnectionFiles(SCOPE, [archived], { db, storage: storage() });

    expect(result.filesPurged).toBe(1);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(1);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-1', -250);
  });

  it('refunds only the live bytes when one slice mixes a live file and a tombstone', async () => {
    const db = makeDb();
    const live = file({ id: 'f-live', fileSize: 500 });
    const tombstone = file({ id: 'f-dead', fileSize: 300, deletedAt: new Date() });

    const result = await purgeDataLakeConnectionFiles(SCOPE, [live, tombstone], { db, storage: storage() });

    expect(result.filesPurged).toBe(2);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(1);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-1', -500);
  });

  it('attributes the refund to each live file owner, a tombstone in the same owner group contributing nothing', async () => {
    const db = makeDb();
    const ownerLive = file({ id: 'f-live', userId: 'owner-1', fileSize: 500 });
    const contributorTombstone = file({
      id: 'f-dead',
      userId: 'contributor-1',
      fileSize: 700,
      deletedAt: new Date(),
    });

    await purgeDataLakeConnectionFiles(SCOPE, [ownerLive, contributorTombstone], { db, storage: storage() });

    expect(db.users.incrementCurrentStorage).toHaveBeenCalledTimes(1);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner-1', -500);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalledWith('contributor-1', expect.anything());
  });

  it('does not refund or count a tombstone a concurrent purge already removed', async () => {
    const db = makeDb();
    db.fabFiles.hardDeleteOneById.mockResolvedValue(false);
    const tombstone = file({ deletedAt: new Date() });

    const result = await purgeDataLakeConnectionFiles(SCOPE, [tombstone], { db, storage: storage() });

    expect(result.filesPurged).toBe(0);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('deletes stored objects for a tombstone without refunding its bytes', async () => {
    const db = makeDb();
    const store = storage();
    const tombstone = file({ filePath: 'files/dead', deletedAt: new Date() });

    const result = await purgeDataLakeConnectionFiles(SCOPE, [tombstone], { db, storage: store });

    expect(store.delete).toHaveBeenCalledWith('files/dead');
    expect(result.storageObjectsDeleted).toBe(1);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });
});
