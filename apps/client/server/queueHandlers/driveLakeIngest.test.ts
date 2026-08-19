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
  lakeFind: vi.fn(),
  userFindById: vi.fn(),
  userRepoFindById: vi.fn(),
  findByDriveConnectionIdInDataLake: vi.fn(),
  fabFileFindById: vi.fn(),
  pushTagsByFabFileId: vi.fn(),
  sessionsWithKnowledgeId: vi.fn(),
  sessionUpdate: vi.fn(),
  deleteFabFile: vi.fn(),
  changeStorageSize: vi.fn(),
  userSave: vi.fn(),
  removeFileFromLake: vi.fn(),
  loadPrefixArmCandidateLakes: vi.fn(),
  findOtherLakeClaims: vi.fn(),
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
  // wider ordering record - user loads, uploads, carry-over writes, deletes - for the invariants that
  // are about WHEN a step runs relative to the others, not just that it ran
  timeline: [] as string[],
}));

vi.mock('@bike4mind/database', () => ({
  User: { findById: h.userFindById },
  changeStorageSize: h.changeStorageSize,
  // The real one gives the quota read-modify-write conflict-checked isolation; here it just runs the
  // body, so the assertions are about WHICH document gets read and when.
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  dataLakeRepository: { findById: h.lakeFindById, find: h.lakeFind },
  dataLakeBatchRepository: {
    create: h.batchCreate,
    findById: h.batchFindById,
    appendFiles: h.appendFiles,
    incrementCounter: h.incrementCounter,
  },
  fabFileRepository: {
    findByDriveConnectionIdInDataLake: h.findByDriveConnectionIdInDataLake,
    findById: h.fabFileFindById,
    pushTagsByFabFileId: h.pushTagsByFabFileId,
  },
  fabFileChunkRepository: {},
  sessionRepository: { findAllWithKnowledgeId: h.sessionsWithKnowledgeId, update: h.sessionUpdate },
  userRepository: { findById: h.userRepoFindById },
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
    loadPrefixArmCandidateLakes: h.loadPrefixArmCandidateLakes,
    // The gate itself is the seam these tests drive; its two-arm resolution is unit-tested beside
    // its source (prefixArmMembership.test.ts). `hasOtherLakeClaim` is the real one-liner.
    findOtherLakeClaims: h.findOtherLakeClaims,
    hasOtherLakeClaim: (claims: { metaTagNames: string[]; prefixArmLakes: unknown[] }) =>
      claims.metaTagNames.length > 0 || claims.prefixArmLakes.length > 0,
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

/**
 * Seed the connection's stored lake members. Feeds both the reconcile's diff query AND the per-id
 * re-read the retire path does after its unpick, so a fixture cannot accidentally describe a file
 * that the diff sees but the retire gate does not.
 */
const setExisting = (docs: Record<string, unknown>[]) => {
  h.findByDriveConnectionIdInDataLake.mockResolvedValue(docs);
  h.fabFileFindById.mockImplementation(async (id: string) => docs.find(doc => doc.id === id) ?? null);
};

describe('driveLakeIngest consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.order.length = 0;
    h.timeline.length = 0;
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
    // A FRESH document per load, recorded, so a test can prove the quota deduction re-reads the user
    // after the uploads instead of reusing the one the handler loaded for its ability check.
    h.userFindById.mockImplementation(async (id: string) => {
      h.timeline.push(`user-load:${id}`);
      return { id, loadedAt: h.timeline.length, save: h.userSave };
    });
    h.userRepoFindById.mockImplementation(async (id: string) => ({ id }));
    setExisting([]);
    h.removeFileFromLake.mockResolvedValue(undefined);
    h.lakeFind.mockResolvedValue([]);
    h.loadPrefixArmCandidateLakes.mockResolvedValue([]);
    // Default: no other lake holds the copy, so the retire is free to delete it outright.
    h.findOtherLakeClaims.mockResolvedValue({ metaTagNames: [], prefixArmLakes: [] });
    h.sessionsWithKnowledgeId.mockResolvedValue([]);
    h.sessionUpdate.mockImplementation(async () => void h.timeline.push('session-link'));
    h.pushTagsByFabFileId.mockImplementation(async () => void h.timeline.push('push-tags'));
    h.userSave.mockResolvedValue(undefined);
    h.changeStorageSize.mockResolvedValue(undefined);
    // The default retire outcome: a full delete that reclaims the stale copy's bytes.
    h.deleteFabFile.mockImplementation(async (_userId, params, adapter) => {
      h.timeline.push(`delete:${params.id}`);
      await adapter.onDeleteComplete?.({ id: params.id }, 100);
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
    h.upload.mockImplementation(async () => {
      h.order.push('upload');
      h.timeline.push('upload');
    });
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
    setExisting([{ id: 'ff-d1', driveFileId: 'd1' }]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 1 }));
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
    expect(h.createFabFile).toHaveBeenCalledWith(expect.objectContaining({ driveFileId: 'd2' }), expect.anything());
    expect(h.removeFileFromLake).not.toHaveBeenCalled();
  });

  it('creates no batch and releases the claim when nothing has changed', async () => {
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    setExisting([{ id: 'ff-d1', driveFileId: 'd1' }]);

    await run();

    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.removeFileFromLake).not.toHaveBeenCalled();
    // The dominant poll outcome, so it must stay cheap: nothing is retired, so the retire gate's
    // candidate-lake lookup is never resolved at all.
    expect(h.loadPrefixArmCandidateLakes).not.toHaveBeenCalled();
    expect(h.updateHealth).toHaveBeenCalledWith('conn1', expect.objectContaining({ status: 'connected' }));
  });

  it('re-ingests an EDITED file: recreates it fresh, THEN unpicks and fully deletes the stale copy', async () => {
    // Same driveFileId, but the Drive md5 moved -> the stored copy is stale.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      { id: 'ff-old', driveFileId: 'd1', userId: 'user1', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
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
    // Reclaimed bytes come off the retired row's own owner.
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), -100);
    expect(h.userSave).toHaveBeenCalledTimes(1);
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 1 }));
  });

  it('gates the hard delete on the POST-unpick tags, the row owner, and this run candidate lakes', async () => {
    // What the gate is asked matters as much as how it answers. It must see the tags that SURVIVE the
    // unpick (re-read from the row, not the pre-unpick copy the diff produced), the RETIRED row's own
    // owner (the prefix arm is owner-anchored), and the lake being left - with the run's pre-resolved
    // candidate lakes threaded through so it is not a query per retire.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    const candidates = [{ id: 'lake-b', createdByUserId: 'owner-alice', fileTagPrefix: 'acme:' }];
    h.loadPrefixArmCandidateLakes.mockResolvedValue(candidates);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'owner-alice',
        driveMd5Checksum: 'OLD',
        // Post-unpick state: this lake's own tag is already gone, the hand-applied one survives.
        tags: [{ name: 'acme:q3' }],
      },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.findOtherLakeClaims).toHaveBeenCalledWith(
      { userId: 'owner-alice', tagNames: ['acme:q3'] },
      expect.objectContaining({ id: 'lake1', datalakeTag: 'lake-tag' }),
      expect.objectContaining({ candidateLakes: candidates })
    );
    // Owners are resolved once for the whole run, not per retire.
    expect(h.loadPrefixArmCandidateLakes).toHaveBeenCalledTimes(1);
    expect(h.loadPrefixArmCandidateLakes).toHaveBeenCalledWith(
      expect.arrayContaining(['user1', 'owner-alice']),
      expect.anything()
    );
  });

  it('does NOT delete a superseded copy that another lake also holds - only unpicks it (P1)', async () => {
    // A file curated into a SECOND lake by hand must not be evicted from it by this poll. `deletedAt`
    // is filtered by every lake's read path, so a blanket soft-delete would silently shrink lake B.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'user1',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'lake-tag' }, { name: 'datalake:handbuilt-b' }],
      },
    ]);
    h.findOtherLakeClaims.mockResolvedValue({ metaTagNames: ['datalake:handbuilt-b'], prefixArmLakes: [] });
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
    // Nothing is carried over either: the copy survives holding its own links and tags, so attaching
    // the replacement alongside it would put the same document in a notebook twice.
    expect(h.sessionUpdate).not.toHaveBeenCalled();
    expect(h.pushTagsByFabFileId).not.toHaveBeenCalled();
    // The replacement is still ingested - lake A is up to date either way.
    expect(h.createFabFile).toHaveBeenCalledWith(
      expect.objectContaining({ driveFileId: 'd1', driveMd5Checksum: 'NEW' }),
      expect.anything()
    );
  });

  it('does NOT delete a copy claimed only through another lake PREFIX arm (no meta-tag) (B1)', async () => {
    // The membership predicate is two-armed, and a file a human curated into lake B via lake B's
    // fileTagPrefix carries NO `datalake:` tag for it. A meta-tag-only gate reads that as "nobody else
    // wants this" and hard-deletes a full member out of lake B, unrecoverably.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'owner-alice',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'lake-tag' }, { name: 'acme:q3' }],
      },
    ]);
    h.findOtherLakeClaims.mockResolvedValue({
      metaTagNames: [],
      prefixArmLakes: [{ id: 'lake-b', createdByUserId: 'owner-alice', fileTagPrefix: 'acme:' }],
    });
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.deleteFabFile).not.toHaveBeenCalled();
    expect(h.changeStorageSize).not.toHaveBeenCalled();
  });

  it.each([
    ['a direct user share', { users: [{ userId: 'bob', permissions: 'read' }] }],
    ['a group share', { groups: [{ groupId: 'g1', permissions: 'read' }] }],
    ['isGlobalRead', { isGlobalRead: true }],
  ])('does NOT delete a superseded copy carrying %s - only unpicks it', async (_label, share) => {
    // The delete is global, so it would take the share vector with it. The replacement is minted for
    // connection.connectedBy alone and carries no shares, so the sharee would be left with a notebook
    // reference getAccessibleFiles silently drops - a loss of access with no signal and no recovery.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'user1',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'lake-tag' }],
        ...share,
      },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // Leaves the Drive lake; the sharee keeps reading the pre-edit copy.
    expect(h.removeFileFromLake).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'ff-old',
      expect.anything()
    );
    expect(h.deleteFabFile).not.toHaveBeenCalled();
    expect(h.changeStorageSize).not.toHaveBeenCalled();
    // Same as the other-lake branch: the copy survives holding its own links and tags, so carrying
    // them onto the replacement would put the same document in a notebook twice.
    expect(h.sessionUpdate).not.toHaveBeenCalled();
    expect(h.pushTagsByFabFileId).not.toHaveBeenCalled();
    // Lake A still gets the fresh copy.
    expect(h.createFabFile).toHaveBeenCalledWith(
      expect.objectContaining({ driveFileId: 'd1', driveMd5Checksum: 'NEW' }),
      expect.anything()
    );
  });

  it('still deletes a superseded copy whose share arrays are present but EMPTY', async () => {
    // The gate keys on a real grant, not on the fields existing - an empty users/groups array is the
    // default shape on every FabFile, so treating presence as a claim would disable the delete branch.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'user1',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'lake-tag' }],
        users: [],
        groups: [],
        isGlobalRead: false,
      },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.deleteFabFile).toHaveBeenCalledWith('user1', { id: 'ff-old' }, expect.anything());
  });

  it('retires pre-existing DUPLICATE copies of a still-present file, keeping the newest (P3)', async () => {
    // main's add-only handler had no walk de-dup, so a multi-parented file or an SQS retry could
    // leave a second non-pending row. It stays a lake member holding pre-edit content and no future
    // walk can see it, because the newest copy shadows it in the diff.
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    setExisting([
      {
        id: 'ff-older',
        driveFileId: 'd1',
        userId: 'user1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tags: [{ name: 'lake-tag' }],
      },
      {
        id: 'ff-newest',
        driveFileId: 'd1',
        userId: 'user1',
        createdAt: '2026-02-01T00:00:00.000Z',
        tags: [{ name: 'lake-tag' }],
      },
    ]);
    h.sessionsWithKnowledgeId.mockResolvedValue([{ id: 'nb1', knowledgeIds: ['ff-older'] }]);

    await run();

    // Only the duplicate goes; the newest copy stays live, so the file never loses its lake member.
    expect(h.deleteFabFile).toHaveBeenCalledTimes(1);
    expect(h.deleteFabFile).toHaveBeenCalledWith('user1', { id: 'ff-older' }, expect.anything());
    // The newest copy is what supersedes the duplicate, so it inherits the duplicate's notebook link
    // instead of the notebook silently losing the document.
    expect(h.sessionUpdate).toHaveBeenCalledWith({ id: 'nb1', knowledgeIds: ['ff-older', 'ff-newest'] });
    // Nothing was edited, so no re-ingest - and the "nothing to ingest" exit still settles what the
    // duplicate retire changed: the reclaimed bytes and the lake's stats.
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), -100);
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
  });

  it('does not double-retire duplicates whose driveFileId is gone from the folder', async () => {
    // Every copy of a vanished driveFileId is already in `removed` and unpicked there; the duplicate
    // sweep must skip it rather than unpick it a second time (removeFileFromLake throws NotFoundError
    // the second time, which would abort the reconcile mid-prune). `keep` anchors the walk so the
    // empty-walk guard does not fire and this actually exercises the prune.
    h.walkFolder.mockResolvedValue([{ id: 'keep', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    setExisting([
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
    setExisting([{ id: 'ff-old', driveFileId: 'd1', driveMd5Checksum: 'OLD' }]);
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
    setExisting(priorDocs);
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
    setExisting([
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
    setExisting([
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
    // The release heals status back to 'connected' and stamps lastPolledAt, so the failure has to ride
    // along as lastError or a deterministically-broken connection reads healthy and freshly-polled.
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 's3 blip');
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
    setExisting([
      { id: 'ff-old1', driveFileId: 'd1', userId: 'user1', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
      { id: 'ff-old2', driveFileId: 'd2', userId: 'user1', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
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
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 's3 blip');
    // The `finally` still deducts what d1's committed delete gave back: the SQS retry re-walks and
    // never sees that copy again, so an un-flushed deduction would bill those bytes forever.
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), -100);
    // ...and still recomputes: the retry sees a folder whose retires are already applied, finds
    // nothing to do, and would skip the recompute too, leaving fileCount overstated indefinitely.
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
  });

  it('deducts reclaimed storage from a user re-read AFTER the uploads, not the one loaded up front (B2)', async () => {
    // changeStorageSize mutates in memory and save() writes an ABSOLUTE currentStorageSize. Every
    // storage.upload in the loop fires objectCreated, which loads and saves its OWN copy of the same
    // user, so deducting against the document read at the top of the handler would overwrite the whole
    // run's upload increments with a value computed before any of them happened.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      { id: 'ff-old', driveFileId: 'd1', userId: 'user1', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // Two distinct loads: the ability check up front, then the deduction - and the deduction's comes
    // after the upload it must not clobber.
    expect(h.timeline).toEqual(['user-load:user1', 'upload', 'push-tags', 'delete:ff-old', 'user-load:user1']);
    // ...and it is genuinely the LATER document that gets mutated, not the one from the first load.
    const deducted = h.changeStorageSize.mock.calls[0][0];
    expect(deducted.loadedAt).toBe(5);
  });

  it('deletes as the retired row OWN owner and refunds that user, not whoever reconnected (B3)', async () => {
    // A reconnect re-stamps connectedBy (drive-sync.ts), after which that user owns none of the rows
    // already ingested. Running the delete as them would either deny - leaving an orphan FabFile plus
    // its chunks and S3 object per edit, with pre-edit content still retrievable - or take
    // deleteFabFile's self-unshare branch, which MUTATES the file's share list and notebook links
    // instead of reaping it.
    h.connFindById.mockResolvedValue({
      id: 'conn1',
      targetDataLakeId: 'lake1',
      connectedBy: 'bob', // reconnected by an org admin, long after alice ingested the folder
      organizationId: 'org1',
      driveFolderId: 'FOLDER',
    });
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      { id: 'ff-old', driveFileId: 'd1', userId: 'alice', driveMd5Checksum: 'OLD', tags: [{ name: 'lake-tag' }] },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.deleteFabFile).toHaveBeenCalledWith('alice', { id: 'ff-old' }, expect.anything());
    // The bytes go back to the owner they were counted against, not to the reconnector.
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'alice' }), -100);
    expect(h.changeStorageSize).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'bob' }), expect.anything());
  });

  it('leaves a copy unpicked rather than failing the run when its owner no longer exists', async () => {
    // deleteFabFile throws UnauthorizedError on a missing actor. Left unguarded that is a deterministic
    // failure: every SQS retry re-walks, re-throws, and the message dies in the DLQ without converging.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'deleted-user',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'lake-tag' }],
      },
    ]);
    h.userRepoFindById.mockResolvedValue(null);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.deleteFabFile).not.toHaveBeenCalled();
    // Still unpicked from this lake, and the replacement still ingested - the run completes.
    expect(h.removeFileFromLake).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'ff-old',
      expect.anything()
    );
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it('carries the retired copy notebook links and hand-applied tags onto the replacement (B4)', async () => {
    // deleteFabFile strips the retired id from every session's knowledgeIds, and the replacement is
    // minted with this lake's tags only. Without a carry-over, a one-character edit in Drive silently
    // detaches the doc from every notebook holding it and drops every tag a human put on it.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'user1',
        driveMd5Checksum: 'OLD',
        tags: [
          { name: 'q3-review', strength: 7 },
          { name: 'legal', strength: 7 },
          { name: 'urgent', strength: 3 },
          // Membership, not content: minted by a lake door, so it must NOT ride along.
          { name: 'datalake:stale-leftover' },
        ],
      },
    ]);
    h.sessionsWithKnowledgeId.mockResolvedValue([
      { id: 'nb1', knowledgeIds: ['ff-old', 'other-file'] },
      { id: 'nb2', knowledgeIds: ['ff-old'] },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    // Every notebook that held the doc now points at the fresh copy. The retired id is still listed
    // here because deleteFabFile is what removes it, in the very next write.
    expect(h.sessionUpdate).toHaveBeenCalledWith({ id: 'nb1', knowledgeIds: ['ff-old', 'other-file', 'ff1'] });
    expect(h.sessionUpdate).toHaveBeenCalledWith({ id: 'nb2', knowledgeIds: ['ff-old', 'ff1'] });
    // Tags keep the strength a human gave them, so they are pushed grouped by it rather than flattened.
    expect(h.pushTagsByFabFileId).toHaveBeenCalledWith('ff1', ['q3-review', 'legal'], 7);
    expect(h.pushTagsByFabFileId).toHaveBeenCalledWith('ff1', ['urgent'], 3);
    expect(h.pushTagsByFabFileId).not.toHaveBeenCalledWith(
      'ff1',
      expect.arrayContaining(['datalake:stale-leftover']),
      expect.anything()
    );
    // The carry-over lands BEFORE the delete that would otherwise destroy it.
    expect(h.timeline.indexOf('session-link')).toBeLessThan(h.timeline.indexOf('delete:ff-old'));
    expect(h.timeline.indexOf('push-tags')).toBeLessThan(h.timeline.indexOf('delete:ff-old'));
  });

  it('does not carry a tag that would enrol the REPLACEMENT in a lake of its own', async () => {
    // After a reconnect the replacement's owner differs from the retired copy's, so a tag that
    // conferred no membership under the old owner can match a prefix arm of a lake the NEW owner
    // created. Carrying it would silently add the fresh copy to that lake, behind the membership doors
    // a real join has to go through.
    h.connFindById.mockResolvedValue({
      id: 'conn1',
      targetDataLakeId: 'lake1',
      connectedBy: 'bob',
      organizationId: 'org1',
      driveFolderId: 'FOLDER',
    });
    h.loadPrefixArmCandidateLakes.mockResolvedValue([
      { id: 'bobs-lake', createdByUserId: 'bob', fileTagPrefix: 'acme:' },
    ]);
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt', md5Checksum: 'NEW' },
    ]);
    setExisting([
      {
        id: 'ff-old',
        driveFileId: 'd1',
        userId: 'alice',
        driveMd5Checksum: 'OLD',
        tags: [{ name: 'acme:q3' }, { name: 'plain-tag' }],
      },
    ]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());

    await run();

    expect(h.pushTagsByFabFileId).toHaveBeenCalledWith('ff1', ['plain-tag'], 0);
    expect(h.pushTagsByFabFileId).not.toHaveBeenCalledWith(
      'ff1',
      expect.arrayContaining(['acme:q3']),
      expect.anything()
    );
  });

  it('flushes reclaimed bytes and recomputes when the DUPLICATE sweep throws part-way (step 4b)', async () => {
    // Step 4b retires too, so it has to sit inside the same try/finally as the ingest loop. Outside it,
    // a throw mid-sweep left the bytes its committed deletes gave back counted against the user
    // forever, and the lake's fileCount overstated.
    h.walkFolder.mockResolvedValue([
      { id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' },
      { id: 'd2', name: 'b.txt', mimeType: 'text/plain', relativePath: 'b.txt' },
    ]);
    setExisting([
      { id: 'ff-a1', driveFileId: 'd1', userId: 'user1', createdAt: '2026-01-01T00:00:00.000Z', tags: [] },
      { id: 'ff-a2', driveFileId: 'd1', userId: 'user1', createdAt: '2026-02-01T00:00:00.000Z', tags: [] },
      { id: 'ff-b1', driveFileId: 'd2', userId: 'user1', createdAt: '2026-01-01T00:00:00.000Z', tags: [] },
      { id: 'ff-b2', driveFileId: 'd2', userId: 'user1', createdAt: '2026-02-01T00:00:00.000Z', tags: [] },
    ]);
    // d1's duplicate retires and reclaims its bytes; d2's unpick then throws mid-sweep.
    h.removeFileFromLake.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('mongo blip'));

    await expect(run()).rejects.toThrow('mongo blip');

    expect(h.deleteFabFile).toHaveBeenCalledTimes(1);
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'user1' }), -100);
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing stats recompute mask the error on its way to SQS', async () => {
    // The recompute runs in the `finally`, so a throw raised there would REPLACE the original error and
    // send SQS the wrong failure.
    h.walkFolder.mockResolvedValue([{ id: 'd1', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' }]);
    setExisting([{ id: 'ff-gone', driveFileId: 'gone', userId: 'user1', tags: [] }]);
    h.fetchDriveFileContent.mockResolvedValue(okBytes());
    h.upload.mockRejectedValueOnce(new Error('s3 blip'));
    h.recomputeLakeStats.mockRejectedValue(new Error('aggregate blew up'));

    await expect(run()).rejects.toThrow('s3 blip');
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
