import { describe, it, expect, vi, beforeEach } from 'vitest';

// Passthrough the wrapper so we drive the raw handler directly.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  // repos + collaborators
  connFindById: vi.fn(),
  claimForSync: vi.fn(),
  releaseSyncClaim: vi.fn(),
  updateHealth: vi.fn(),
  lakeFindById: vi.fn(),
  userFindById: vi.fn(),
  findByDriveConnectionIdInDataLake: vi.fn(),
  deleteFabFile: vi.fn(),
  changeStorageSize: vi.fn(),
  userSave: vi.fn(),
  removeFileFromLake: vi.fn(),
  recomputeLakeStats: vi.fn(),
  batchCreate: vi.fn(),
  batchFindById: vi.fn(),
  appendFiles: vi.fn(),
  incrementCounter: vi.fn(),
  createFabFile: vi.fn(),
  upload: vi.fn(),
  walkFolder: vi.fn(),
  fetchDriveFileContent: vi.fn(),
  finalizeBatchIfComplete: vi.fn(),
  sendToQueue: vi.fn(),
  // records the interleaving of manifest-append vs byte-upload to assert ordering
  order: [] as string[],
}));

vi.mock('@bike4mind/database', () => ({
  User: { findById: h.userFindById },
  changeStorageSize: h.changeStorageSize,
  dataLakeRepository: { findById: h.lakeFindById },
  dataLakeBatchRepository: {
    create: h.batchCreate,
    findById: h.batchFindById,
    appendFiles: h.appendFiles,
    incrementCounter: h.incrementCounter,
  },
  fabFileRepository: {
    findByDriveConnectionIdInDataLake: h.findByDriveConnectionIdInDataLake,
  },
  fabFileChunkRepository: {},
  sessionRepository: {},
  userRepository: {},
  orgGoogleDriveConnectionRepository: {
    findById: h.connFindById,
    claimForSync: h.claimForSync,
    releaseSyncClaim: h.releaseSyncClaim,
    updateHealth: h.updateHealth,
  },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    createDataLakeFallbackTagger: () => async (tags: unknown) => tags,
    removeFileFromLake: h.removeFileFromLake,
    recomputeLakeStats: h.recomputeLakeStats,
  },
  fabFilesService: { deleteFabFile: h.deleteFabFile },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('@server/managers/fabFileManager', () => ({ createFabFile: h.createFabFile }));
vi.mock('@server/auth/ability', () => ({ default: () => ({}) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ upload: h.upload }) }));
vi.mock('@server/integrations/google/drive/common', () => ({
  getValidConnectionDriveAccessToken: async () => 'access-token',
}));
vi.mock('@server/integrations/google/drive/driveClient', () => ({ createDriveClient: () => ({}) }));
vi.mock('@server/integrations/google/drive/driveContent', () => ({
  walkFolder: h.walkFolder,
  fetchDriveFileContent: h.fetchDriveFileContent,
}));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: h.finalizeBatchIfComplete,
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('sst', () => ({ Resource: { driveLakeIngestQueue: { url: 'ingest-queue-url' } } }));

import { dispatch, hasDriveFileChanged } from './driveLakeIngest';

const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const makeEvent = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const run = (body: Record<string, unknown> = { connectionId: 'conn1' }) =>
  dispatch(makeEvent(body), {} as never, logger);

const okBytes = (n = 10) => ({ ok: true as const, bytes: Buffer.alloc(n), mimeType: 'text/plain' });

describe('driveLakeIngest consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.order.length = 0;
    h.connFindById.mockResolvedValue({
      id: 'conn1',
      targetDataLakeId: 'lake1',
      connectedBy: 'user1',
      organizationId: 'org1',
      driveFolderId: 'FOLDER',
    });
    h.claimForSync.mockResolvedValue(true);
    h.releaseSyncClaim.mockResolvedValue(null);
    h.updateHealth.mockResolvedValue(null);
    h.lakeFindById.mockResolvedValue({
      id: 'lake1',
      datalakeTag: 'lake-tag',
      fileTagPrefix: 'demo:',
      createdByUserId: 'creator1',
    });
    h.userFindById.mockResolvedValue({ id: 'user1', save: h.userSave });
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([]);
    h.removeFileFromLake.mockResolvedValue(undefined);
    h.userSave.mockResolvedValue(undefined);
    h.changeStorageSize.mockResolvedValue(undefined);
    // The default retire outcome: a full delete that reclaims the stale copy's bytes.
    h.deleteFabFile.mockImplementation(async (_userId, _params, adapter) => {
      await adapter.onDeleteComplete?.({ id: 'stale' }, 100);
      return { action: 'deleted' };
    });
    h.recomputeLakeStats.mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 });
    h.batchCreate.mockResolvedValue({ id: 'batch1' });
    h.batchFindById.mockResolvedValue({
      id: 'batch1',
      totalFiles: 0,
      vectorizedFiles: 0,
      failedFiles: 0,
      skippedFiles: 0,
    });
    h.appendFiles.mockImplementation(async () => void h.order.push('append'));
    h.incrementCounter.mockResolvedValue(null);
    h.upload.mockImplementation(async () => void h.order.push('upload'));
    let n = 0;
    h.createFabFile.mockImplementation(async () => ({ id: `ff${++n}` }));
  });

  it('is a cheap no-op when the claim is lost and there is nothing in flight to defer behind', async () => {
    h.claimForSync.mockResolvedValue(false);
    // Default connection has no 'syncing' status, so this is a duplicate/errored case, not a genuine
    // second sync - drop it (do not re-enqueue) and do not release a claim it does not own.
    await run();
    expect(h.walkFolder).not.toHaveBeenCalled();
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('defers a genuine second sync (re-enqueue with delay) when a real run is in flight', async () => {
    h.claimForSync.mockResolvedValue(false);
    h.connFindById.mockResolvedValue({
      id: 'conn1',
      status: 'syncing', // another run genuinely holds the claim
      targetDataLakeId: 'lake1',
      connectedBy: 'user1',
      organizationId: 'org1',
      driveFolderId: 'FOLDER',
    });

    await run();

    expect(h.sendToQueue).toHaveBeenCalledWith(
      'ingest-queue-url',
      { connectionId: 'conn1', redriveCount: 1 },
      expect.any(Number)
    );
    expect(h.walkFolder).not.toHaveBeenCalled();
  });

  it('stops deferring once the redrive bound is hit (cannot spin)', async () => {
    h.claimForSync.mockResolvedValue(false);
    h.connFindById.mockResolvedValue({
      id: 'conn1',
      status: 'syncing',
      targetDataLakeId: 'lake1',
      connectedBy: 'user1',
      organizationId: 'org1',
      driveFolderId: 'FOLDER',
    });

    await run({ connectionId: 'conn1', redriveCount: 99 });

    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('appends each manifest entry BEFORE its bytes are uploaded', async () => {
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' },
      { id: 'd2', name: 'b.txt', mimeType: 'text/plain', relativePath: 'b.txt' },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // Manifest entry must precede the upload for every file, or the objectCreated -> chunk ->
    // vectorize claims race an empty `files` array and the batch never finalizes.
    expect(h.order).toEqual(['append', 'upload', 'append', 'upload']);
    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 2 }));
  });

  it('skips an oversized file before fetching it and counts it into skippedFiles', async () => {
    h.walkFolder.mockResolvedValue([
      { id: 'big', name: 'huge.pdf', mimeType: 'application/pdf', relativePath: 'huge.pdf', size: 200 * 1024 * 1024 },
      { id: 'ok', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // The oversized candidate is never downloaded, but it IS accounted so totalFiles stays reachable.
    expect(h.fetchDriveFileContent).toHaveBeenCalledTimes(1);
    expect(h.fetchDriveFileContent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'ok' }));
    expect(h.incrementCounter).toHaveBeenCalledWith('batch1', 'skippedFiles');
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it('ingests only the genuinely-new file, skipping one already in the lake (unchanged)', async () => {
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' },
      { id: 'd2', name: 'b.txt', mimeType: 'text/plain', relativePath: 'b.txt' },
    ]);
    // d1 is already ingested with no md5/modifiedTime; the walked d1 also carries none, so it is
    // UNCHANGED (not an update) and must be skipped. d2 is new.
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([{ id: 'ff-d1', driveFileId: 'd1' }]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 1 }));
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
    expect(h.createFabFile).toHaveBeenCalledWith(expect.objectContaining({ driveFileId: 'd2' }), expect.anything());
    expect(h.removeFileFromLake).not.toHaveBeenCalled();
  });

  it('creates no batch and releases the claim when nothing has changed', async () => {
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([{ id: 'ff-d1', driveFileId: 'd1' }]);

    await run();

    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.removeFileFromLake).not.toHaveBeenCalled();
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'connected' }));
  });

  it('re-ingests an EDITED file: recreates it fresh, THEN unpicks and fully deletes the stale copy', async () => {
    // Same driveFileId, but the Drive md5 moved -> the stored copy is stale.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-old', driveFileId: 'd1', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // The fresh copy is created and uploaded FIRST; only then is the superseded copy retired.
    expect(h.createFabFile).toHaveBeenCalledWith(
      expect.objectContaining({ driveFileId: 'd1', driveMd5Checksum: 'NEW' }),
      expect.anything()
    );
    expect(h.order).toEqual(['append', 'upload']);
    // Per-lake unpick FIRST, then the full delete - never a bare deletedAt stamp, which every other
    // lake's read path would honour too.
    expect(h.removeFileFromLake).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'ff-old',
      expect.anything()
    );
    // The full delete reaps chunks / search index / session links / S3 / quota, unlike a soft-delete.
    expect(h.deleteFabFile).toHaveBeenCalledTimes(1);
    expect(h.deleteFabFile).toHaveBeenCalledWith('user1', { id: 'ff-old' }, expect.anything());
    // Reclaimed bytes come off the connecting user's counted storage.
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), -100);
    expect(h.userSave).toHaveBeenCalledTimes(1);
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 1 }));
  });

  it('does NOT delete a superseded copy that another lake also holds - only unpicks it (P1)', async () => {
    // A file curated into a SECOND lake by hand must not be evicted from it by this poll. `deletedAt`
    // is filtered by every lake's read path, so a blanket soft-delete would silently shrink lake B.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'lake-tag' }, { name: 'datalake:handbuilt-b' }],
      },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // Leaves the Drive lake, keeps living in lake B.
    expect(h.removeFileFromLake).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'ff-old',
      expect.anything()
    );
    expect(h.deleteFabFile).not.toHaveBeenCalled();
    expect(h.changeStorageSize).not.toHaveBeenCalled();
    // The replacement is still ingested - lake A is up to date either way.
    expect(h.createFabFile).toHaveBeenCalledWith(
      expect.objectContaining({ driveFileId: 'd1', driveMd5Checksum: 'NEW' }),
      expect.anything()
    );
  });

  it('matches another lake tag case-insensitively before deciding to delete', async () => {
    // Tag documents keep whatever casing they were created with, so the guard folds case - a
    // `DATALAKE:Other` membership must protect the file exactly as `datalake:other` would.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'LAKE-TAG' }, { name: 'DATALAKE:Other' }],
      },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.deleteFabFile).not.toHaveBeenCalled();
  });

  it('retires pre-existing DUPLICATE copies of a still-present file, keeping the newest (P3)', async () => {
    // main's add-only handler had no walk de-dup, so a multi-parented file or an SQS retry could
    // leave a second non-pending row. It stays a lake member holding pre-edit content and no future
    // walk can see it, because the newest copy shadows it in the diff.
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-older', driveFileId: 'd1', createdAt: '2026-01-01T00:00:00.000Z', tags: [{ name: 'lake-tag' }] },
      { id: 'ff-newest', driveFileId: 'd1', createdAt: '2026-02-01T00:00:00.000Z', tags: [{ name: 'lake-tag' }] },
    ]);

    await run();

    // Only the duplicate goes; the newest copy stays live, so the file never loses its lake member.
    expect(h.deleteFabFile).toHaveBeenCalledTimes(1);
    expect(h.deleteFabFile).toHaveBeenCalledWith('user1', { id: 'ff-older' }, expect.anything());
    // Nothing was edited, so no re-ingest - the duplicate retire alone still recomputes stats.
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
  });

  it('does not double-retire duplicates whose driveFileId is gone from the folder', async () => {
    // Every copy of a vanished driveFileId is already in `removed` and unpicked there; the duplicate
    // sweep must skip it rather than unpick it a second time (removeFileFromLake throws NotFoundError
    // the second time, which would abort the reconcile mid-prune). `keep` anchors the walk so the
    // empty-walk guard does not fire and this actually exercises the prune.
    h.walkFolder.mockResolvedValue([{ id: 'keep', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-keep', driveFileId: 'keep', createdAt: '2026-01-01T00:00:00.000Z', tags: [{ name: 'lake-tag' }] },
      { id: 'ff-a', driveFileId: 'gone', createdAt: '2026-01-01T00:00:00.000Z', tags: [{ name: 'lake-tag' }] },
      { id: 'ff-b', driveFileId: 'gone', createdAt: '2026-02-01T00:00:00.000Z', tags: [{ name: 'lake-tag' }] },
    ]);

    await run();

    // Both vanished copies unpicked exactly once each, by the genuine-delete pass only.
    expect(h.removeFileFromLake).toHaveBeenCalledTimes(2);
    expect(h.removeFileFromLake).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ff-a', expect.anything());
    expect(h.removeFileFromLake).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ff-b', expect.anything());
    // A genuine delete is membership-only - the owner keeps their copy, nothing is deleted outright.
    expect(h.deleteFabFile).not.toHaveBeenCalled();
  });

  it('does NOT retire the stale copy when the edited file fails to re-fetch (no eviction)', async () => {
    // B2: an edit that pushes a file past a deterministic fetch gate (oversized / unsupported /
    // export-too-large) must leave the working pre-edit copy in place, not evict it for good.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-old', driveFileId: 'd1', driveMd5Checksum: 'OLD' },
    ]);
    h.fetchDriveFileContent.mockResolvedValue({ ok: false as const, reason: 'unsupported' });

    await run();

    // Nothing uploaded, so the stale copy stays: no delete, no membership pull, no stats churn.
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.deleteFabFile).not.toHaveBeenCalled();
    expect(h.removeFileFromLake).not.toHaveBeenCalled();
    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
    expect(h.incrementCounter).toHaveBeenCalledWith('batch1', 'skippedFiles');
  });

  it('refuses an over-cap folder BEFORE any removal, so an edit-heavy over-cap run evicts nothing', async () => {
    // B1: removals must not run on a run that then bails at the cap. Existing lake members + >cap
    // candidates (adds + one edit) must leave the lake untouched - no delete, no retire, no stats.
    const priorDocs = Array.from({ length: 3 }, (_, i) => ({
      id: `ff-e${i}`,
      driveFileId: `e${i}`,
      driveMd5Checksum: 'OLD',
    }));
    const edits = priorDocs.map((_, i) => ({
      id: `e${i}`,
      name: `e${i}.txt`,
      mimeType: 'text/plain',
      relativePath: `e${i}.txt`,
      md5Checksum: 'NEW',
    }));
    const adds = Array.from({ length: 1500 }, (_, i) => ({
      id: `a${i}`,
      name: `a${i}.txt`,
      mimeType: 'text/plain',
      relativePath: `a${i}.txt`,
    }));
    h.findByDriveConnectionIdInDataLake.mockResolvedValue(priorDocs);
    h.walkFolder.mockResolvedValue([...edits, ...adds]); // 1503 candidates > 1500 cap

    await run();

    expect(h.removeFileFromLake).not.toHaveBeenCalled();
    expect(h.deleteFabFile).not.toHaveBeenCalled();
    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
    expect(h.updateHealth).toHaveBeenCalledWith(
      'conn1',
      expect.objectContaining({ status: 'connected', lastError: expect.stringContaining('limit for a single sync') })
    );
  });

  it('removes a file from the lake when it is gone from the folder (no re-ingest)', async () => {
    // d1 still present (unchanged); d2 vanished from the folder -> prune its lake membership.
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-d1', driveFileId: 'd1' },
      { id: 'ff-d2', driveFileId: 'd2' },
    ]);

    await run();

    expect(h.removeFileFromLake).toHaveBeenCalledTimes(1);
    expect(h.removeFileFromLake).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ff-d2', expect.anything());
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'connected' }));
  });

  it('refuses to prune the whole lake when the folder walk comes back empty (transient-glitch guard)', async () => {
    // An empty walk while the lake still holds files is treated as a Drive hiccup, not a real
    // empty-out: no removals, no batch, just a clean health update.
    h.walkFolder.mockResolvedValue([]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-d1', driveFileId: 'd1' },
      { id: 'ff-d2', driveFileId: 'd2' },
    ]);

    await run();

    expect(h.removeFileFromLake).not.toHaveBeenCalled();
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'connected' }));
  });

  it('refuses a folder over the candidate cap before creating any batch or FabFile', async () => {
    // A folder too large to finish in one 10-min run would time out mid-loop every attempt and, since
    // the retry re-creates the un-uploaded tail, accumulate duplicates. Refuse up front - no batch, no
    // FabFile, a guiding error - so no partial state is ever written.
    const tooMany = Array.from({ length: 1501 }, (_, i) => ({
      id: `d${i}`,
      name: `f${i}.txt`,
      mimeType: 'text/plain',
      relativePath: `f${i}.txt`,
    }));
    h.walkFolder.mockResolvedValue(tooMany);

    await run();

    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
    expect(h.updateHealth).toHaveBeenCalledWith(
      'conn1',
      expect.objectContaining({ status: 'connected', lastError: expect.stringContaining('limit for a single sync') })
    );
  });

  it('releases the syncing claim (guarded) when the run throws mid-ingest', async () => {
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());
    h.upload.mockRejectedValueOnce(new Error('s3 blip'));

    await expect(run()).rejects.toThrow('s3 blip');
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1');
  });

  it('de-dups a multi-parented file so it is ingested once, not twice', async () => {
    // A legacy multi-parented Drive file surfaces once per parent in the walk; without de-dup it
    // would create two FabFiles for one add (and, when edited, double-remove -> NotFoundError throw).
    h.walkFolder.mockResolvedValue([
      { id: 'dup', name: 'a.txt', mimeType: 'text/plain', relativePath: 'p1/a.txt' },
      { id: 'dup', name: 'a.txt', mimeType: 'text/plain', relativePath: 'p2/a.txt' },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 1 }));
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
  });

  it('retires an already-processed edit even when a LATER file throws mid-loop', async () => {
    // Per-file retirement (not batched at the end): the first edited file uploads and its stale copy
    // is retired BEFORE the second is processed, so a later throw does not strand ff-old1 as a
    // duplicate lake member. Both are edits, since candidates order adds before edits.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
      { id: 'd2', name: 'b.txt', mimeType: 'text/plain', relativePath: 'b.txt', md5Checksum: 'NEW' },
    ]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-old1', driveFileId: 'd1', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
      { id: 'ff-old2', driveFileId: 'd2', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());
    // d1 uploads fine (and is retired); d2's upload throws before its own retire.
    h.upload
      .mockImplementationOnce(async () => void h.order.push('upload'))
      .mockRejectedValueOnce(new Error('s3 blip'));

    await expect(run()).rejects.toThrow('s3 blip');

    // d1's stale copy was already retired; d2's was not (it threw first) - no orphaned duplicate for d1.
    expect(h.deleteFabFile).toHaveBeenCalledWith('user1', { id: 'ff-old1' }, expect.anything());
    expect(h.deleteFabFile).not.toHaveBeenCalledWith('user1', { id: 'ff-old2' }, expect.anything());
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1');
    // The `finally` still deducts what d1's committed delete gave back: the SQS retry re-walks and
    // never sees that copy again, so an un-flushed deduction would bill those bytes forever.
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), -100);
  });
});

describe('hasDriveFileChanged', () => {
  it('uses md5 when both sides carry it (native files)', () => {
    expect(hasDriveFileChanged({ driveMd5Checksum: 'A' }, { md5Checksum: 'A' })).toBe(false);
    expect(hasDriveFileChanged({ driveMd5Checksum: 'A' }, { md5Checksum: 'B' })).toBe(true);
  });

  it('falls back to modifiedTime for Google Editors files (no md5), strict-newer only', () => {
    // The Editors path is the entire reason the function exists: Docs/Sheets/Slides carry no md5.
    const prior = { driveModifiedTime: '2026-01-01T00:00:00.000Z' };
    expect(hasDriveFileChanged(prior, { modifiedTime: '2026-01-02T00:00:00.000Z' })).toBe(true);
    // Same timestamp (re-listed but unedited) is NOT a change.
    expect(hasDriveFileChanged(prior, { modifiedTime: '2026-01-01T00:00:00.000Z' })).toBe(false);
    // An older fresh timestamp is never treated as a change.
    expect(hasDriveFileChanged(prior, { modifiedTime: '2025-12-31T00:00:00.000Z' })).toBe(false);
  });

  it('accepts a Date-typed prior modifiedTime (as stored on the FabFile row)', () => {
    const prior = { driveModifiedTime: new Date('2026-01-01T00:00:00.000Z') };
    expect(hasDriveFileChanged(prior, { modifiedTime: '2026-01-02T00:00:00.000Z' })).toBe(true);
  });

  it('prefers md5 even when a modifiedTime is also present (mixed signals)', () => {
    // Both signals available: md5 is exact, so it wins and a moved modifiedTime does not override it.
    expect(
      hasDriveFileChanged(
        { driveMd5Checksum: 'A', driveModifiedTime: '2026-01-01T00:00:00.000Z' },
        { md5Checksum: 'A', modifiedTime: '2026-06-01T00:00:00.000Z' }
      )
    ).toBe(false);
  });

  it('is conservative when only one side has a comparable signal', () => {
    // Fresh has md5 but the prior row predates provenance (no md5, no modifiedTime): cannot prove
    // staleness, so never churn.
    expect(hasDriveFileChanged({}, { md5Checksum: 'A' })).toBe(false);
    // Fresh has md5, prior has ONLY modifiedTime: no comparable pair, still conservative.
    expect(hasDriveFileChanged({ driveModifiedTime: '2026-01-01T00:00:00.000Z' }, { md5Checksum: 'A' })).toBe(false);
  });
});
