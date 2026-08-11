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
  findByDriveFileIdsInDataLake: vi.fn(),
  batchCreate: vi.fn(),
  batchFindById: vi.fn(),
  appendFiles: vi.fn(),
  incrementCounter: vi.fn(),
  createFabFile: vi.fn(),
  upload: vi.fn(),
  walkFolder: vi.fn(),
  fetchDriveFileContent: vi.fn(),
  finalizeBatchIfComplete: vi.fn(),
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
  fabFileRepository: { findByDriveFileIdsInDataLake: h.findByDriveFileIdsInDataLake },
  orgGoogleDriveConnectionRepository: {
    findById: h.connFindById,
    claimForSync: h.claimForSync,
    releaseSyncClaim: h.releaseSyncClaim,
    updateHealth: h.updateHealth,
  },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { createDataLakeFallbackTagger: () => async (tags: unknown) => tags },
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

import { dispatch } from './driveLakeIngest';

const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const makeEvent = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const run = () => dispatch(makeEvent({ connectionId: 'conn1' }), {} as never, logger);

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
    h.lakeFindById.mockResolvedValue({ id: 'lake1', datalakeTag: 'lake-tag' });
    h.userFindById.mockResolvedValue({ id: 'user1' });
    h.findByDriveFileIdsInDataLake.mockResolvedValue([]);
    h.batchCreate.mockResolvedValue({ id: 'batch1' });
    h.batchFindById.mockResolvedValue({ id: 'batch1', totalFiles: 0, vectorizedFiles: 0, failedFiles: 0, skippedFiles: 0 });
    h.appendFiles.mockImplementation(async () => void h.order.push('append'));
    h.incrementCounter.mockResolvedValue(null);
    h.upload.mockImplementation(async () => void h.order.push('upload'));
    let n = 0;
    h.createFabFile.mockImplementation(async () => ({ id: `ff${++n}` }));
  });

  it('is a cheap no-op when another run already holds the syncing claim', async () => {
    h.claimForSync.mockResolvedValue(false);
    await run();
    expect(h.walkFolder).not.toHaveBeenCalled();
    expect(h.batchCreate).not.toHaveBeenCalled();
    // The loser must NOT release a claim it does not own.
    expect(h.releaseSyncClaim).not.toHaveBeenCalled();
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

  it('excludes already-ingested Drive files via the dedup lookup', async () => {
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' },
      { id: 'd2', name: 'b.txt', mimeType: 'text/plain', relativePath: 'b.txt' },
    ]);
    h.findByDriveFileIdsInDataLake.mockResolvedValue([{ driveFileId: 'd1' }]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 1 }));
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
    expect(h.createFabFile).toHaveBeenCalledWith(
      expect.objectContaining({ driveFileId: 'd2' }),
      expect.anything()
    );
  });

  it('creates no batch and releases the claim when nothing is new', async () => {
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    h.findByDriveFileIdsInDataLake.mockResolvedValue([{ driveFileId: 'd1' }]);

    await run();

    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'connected' }));
  });

  it('releases the syncing claim (guarded) when the run throws mid-ingest', async () => {
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());
    h.upload.mockRejectedValueOnce(new Error('s3 blip'));

    await expect(run()).rejects.toThrow('s3 blip');
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1');
  });
});
