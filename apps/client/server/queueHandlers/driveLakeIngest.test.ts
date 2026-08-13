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
  dataLakeRepository: { findById: h.lakeFindById },
  dataLakeBatchRepository: {
    create: h.batchCreate,
    findById: h.batchFindById,
    appendFiles: h.appendFiles,
    incrementCounter: h.incrementCounter,
  },
  fabFileRepository: { findByDriveConnectionIdInDataLake: h.findByDriveConnectionIdInDataLake },
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
}));
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

import { dispatch } from './driveLakeIngest';

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
    h.userFindById.mockResolvedValue({ id: 'user1' });
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([]);
    h.removeFileFromLake.mockResolvedValue(undefined);
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

  it('re-ingests an EDITED file: pulls the stale copy from the lake, then recreates it fresh', async () => {
    // Same driveFileId, but the Drive md5 moved -> the stored copy is stale.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    h.findByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'ff-old', driveFileId: 'd1', driveMd5Checksum: 'OLD' },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // Stale copy leaves the lake (membership pull) before the fresh ingest, and stats recompute once.
    expect(h.removeFileFromLake).toHaveBeenCalledTimes(1);
    expect(h.removeFileFromLake).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: true }),
      expect.objectContaining({ id: 'lake1', datalakeTag: 'lake-tag' }),
      'ff-old',
      expect.anything()
    );
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 1 }));
    expect(h.createFabFile).toHaveBeenCalledWith(
      expect.objectContaining({ driveFileId: 'd1', driveMd5Checksum: 'NEW' }),
      expect.anything()
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
});
