import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  dlFindById: vi.fn(),
  connFindByDataLakeIdAny: vi.fn(),
  connMarkDisconnecting: vi.fn(
    async (): Promise<{ stamp: Date; created: boolean; previousEnabled: boolean } | null> => null
  ),
  connTouchDisconnect: vi.fn(async () => true),
  findFiles: vi.fn(async (): Promise<unknown[]> => []),
  findOrphans: vi.fn(async (): Promise<unknown[]> => []),
  userFindById: vi.fn(async (id: string) => ({ id })),
  deleteFabFile: vi.fn(
    async (
      _userId: string,
      params: { id: string },
      adapter: { onDeleteComplete?: (fabFile: unknown, size: number) => Promise<void> }
    ) => {
      await adapter.onDeleteComplete?.({ id: params.id }, 100);
      return { action: 'deleted', fabFile: null };
    }
  ),
  findOtherLakeClaims: vi.fn(async () => ({ metaTagNames: [], prefixArmLakes: [] })),
  loadPrefixArmCandidateLakes: vi.fn(async () => []),
  bestEffortAdjustOwnerStorage: vi.fn(async () => undefined),
  groupStorageDeltaByOwner: vi.fn((swept: { id: string; userId: string; fileSize: number }[]) => {
    const totals = new Map<string, number>();
    for (const f of swept) totals.set(f.userId, (totals.get(f.userId) ?? 0) + f.fileSize);
    return totals;
  }),
  purge: vi.fn(async () => ({ filesPurged: 0, storageObjectsDeleted: 0 })),
  recomputeLakeStats: vi.fn(async () => ({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 })),
  releaseDriveConnection: vi.fn(async () => true),
  shredMemoryForLakeTags: vi.fn(),
  sendToQueue: vi.fn(async () => 'msg-2'),
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findById: h.dlFindById },
  orgGoogleDriveConnectionRepository: {
    findByDataLakeIdAny: h.connFindByDataLakeIdAny,
    markDisconnecting: h.connMarkDisconnecting,
    touchDisconnect: h.connTouchDisconnect,
  },
  fabFileRepository: {
    findByDriveConnectionIdInDataLake: h.findFiles,
    findLiveNonMembersByDriveConnectionId: h.findOrphans,
  },
  fabFileChunkRepository: {},
  dataLakeFindingRepository: {},
  sessionRepository: {},
  userRepository: { findById: h.userFindById },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    purgeDataLakeConnectionFiles: h.purge,
    lakeMembershipScope: (lake: unknown) => lake,
    openSearchRetrievalIndex: vi.fn(),
    recomputeLakeStats: h.recomputeLakeStats,
    loadPrefixArmCandidateLakes: h.loadPrefixArmCandidateLakes,
    findOtherLakeClaims: h.findOtherLakeClaims,
    hasOtherLakeClaim: (claims: { metaTagNames: string[]; prefixArmLakes: unknown[] }) =>
      claims.metaTagNames.length > 0 || claims.prefixArmLakes.length > 0,
    bestEffortAdjustOwnerStorage: h.bestEffortAdjustOwnerStorage,
    groupStorageDeltaByOwner: h.groupStorageDeltaByOwner,
  },
  fabFilesService: { deleteFabFile: h.deleteFabFile },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('sst', () => ({ Resource: { driveDisconnectPurgeQueue: { url: 'purge-queue-url' } } }));
vi.mock('@server/integrations/google/drive/common', () => ({ releaseDriveConnection: h.releaseDriveConnection }));
vi.mock('@server/dataLakes/shredMemoryForLakeTags', () => ({ shredMemoryForLakeTags: h.shredMemoryForLakeTags }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ delete: vi.fn() }) }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));

import { dispatch } from './driveDisconnectPurge';
import type { DriveConnectionOwner } from '@bike4mind/common';

const orgAOwner: DriveConnectionOwner = { kind: 'organization', organizationId: 'orgA' };
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const payload = { connectionId: 'conn1', dataLakeId: 'lake1', organizationId: 'orgA' };
const makeEvent = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const run = (body: unknown = payload) => dispatch(makeEvent(body), {} as never, logger);
const file = (id: string) => ({ id, userId: 'u1', fileSize: 10, filePath: `p-${id}`, versions: [], tags: [] });
const lake = { id: 'lake1', organizationId: 'orgA', datalakeTag: 'datalake:lake1', createdByUserId: 'owner1' };
const pendingConn = { id: 'conn1', organizationId: 'orgA', enabled: false, disconnectRequestedAt: new Date() };

describe('driveDisconnectPurge consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue(lake);
    h.connFindByDataLakeIdAny.mockResolvedValue(pendingConn);
    h.connMarkDisconnecting.mockResolvedValue({ stamp: new Date(), created: false, previousEnabled: false });
    h.findFiles.mockResolvedValue([]);
    h.findOrphans.mockResolvedValue([]);
    h.findOtherLakeClaims.mockResolvedValue({ metaTagNames: [], prefixArmLakes: [] });
    h.loadPrefixArmCandidateLakes.mockResolvedValue([]);
    h.userFindById.mockImplementation(async (id: string) => ({ id }));
  });

  it('purges the ingested files, recomputes stats, then releases the connection', async () => {
    const files = [file('f1'), file('f2')];
    h.findFiles.mockResolvedValue(files);
    const calls: string[] = [];
    h.purge.mockImplementationOnce(async () => (calls.push('purge'), { filesPurged: 2, storageObjectsDeleted: 2 }));
    h.recomputeLakeStats.mockImplementationOnce(
      async () => (calls.push('recompute'), { fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 })
    );
    h.releaseDriveConnection.mockImplementationOnce(async () => (calls.push('release'), true));

    await run();

    expect(h.connMarkDisconnecting).toHaveBeenCalledWith('conn1', orgAOwner);
    // includeDeleted, not the reconcile-scoped default, and one slice plus a lookahead row.
    expect(h.findFiles).toHaveBeenCalledWith('conn1', 'datalake:lake1', { includeDeleted: true, limit: 1001 });
    expect(h.purge).toHaveBeenCalledWith(expect.anything(), files, expect.anything());
    const adapters = (h.purge.mock.calls[0] as unknown[])[2] as { db: Record<string, unknown> };
    expect(adapters.db.sessions).toBeDefined();
    expect(adapters.db.dataLakeFindings).toBeDefined();
    // Through the revoking seam, and only once every file is gone: the row is the retry anchor.
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', orgAOwner);
    expect(calls).toEqual(['purge', 'recompute', 'release']);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('purges a personal connection (no organizationId) and releases it as its user owner', async () => {
    const personalPayload = { connectionId: 'conn1', dataLakeId: 'lake1' };
    const personalConn = { id: 'conn1', connectedBy: 'user1', enabled: false, disconnectRequestedAt: new Date() };
    h.connFindByDataLakeIdAny.mockResolvedValue(personalConn);
    h.findFiles.mockResolvedValue([file('f1')]);

    await run(personalPayload);

    const userOwner: DriveConnectionOwner = { kind: 'user', userId: 'user1' };
    expect(h.connMarkDisconnecting).toHaveBeenCalledWith('conn1', userOwner);
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', userOwner);
  });

  it('wires a shredDocumentMemory callback that shreds each purged file against this lake', async () => {
    h.findFiles.mockResolvedValue([file('f1')]);
    h.purge.mockImplementationOnce(async (...args: unknown[]) => {
      const adapters = args[2] as { shredDocumentMemory: (a: unknown) => Promise<void> };
      await adapters.shredDocumentMemory({ tagNames: ['datalake:lake1'], fabFileId: 'f1', ownerUserId: 'u1' });
      return { filesPurged: 1, storageObjectsDeleted: 1 };
    });
    await run();
    expect(h.shredMemoryForLakeTags).toHaveBeenCalledWith(
      ['datalake:lake1'],
      'f1',
      'u1',
      { id: 'lake1', datalakeTag: 'datalake:lake1', createdByUserId: 'owner1' },
      expect.anything()
    );
  });

  it('re-enqueues itself for the remainder when a connection holds more than one slice', async () => {
    h.findFiles.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => file(`f${i}`)));
    await run();

    const purged = (h.purge.mock.calls[0] as unknown[])[1] as unknown[];
    expect(purged).toHaveLength(1000);
    expect(h.recomputeLakeStats).toHaveBeenCalled();
    expect(h.sendToQueue).toHaveBeenCalledWith('purge-queue-url', payload, undefined);
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
  });

  const orphan = (over: Record<string, unknown> = {}) => ({
    id: 'orphan1',
    userId: 'u1',
    users: [],
    groups: [],
    isGlobalRead: false,
    tags: [],
    driveConnectionId: 'conn1',
    status: 'complete',
    fileSize: 100,
    ...over,
  });

  it('sweeps the unpicked orphans once every member slice is gone, deleting each as its owner', async () => {
    // The member purge is meta-tag scoped, so a file the connector UNPICKED - removed from the folder
    // before this change, or an unconfirmed removal now - keeps its driveConnectionId but is invisible
    // to it. The sweep is the backstop that stops such an orphan outliving its connection.
    h.findFiles.mockResolvedValue([file('f1')]);
    h.findOrphans.mockResolvedValue([orphan()]);

    await run();

    expect(h.findOrphans).toHaveBeenCalledWith('conn1', 'datalake:lake1');
    expect(h.deleteFabFile).toHaveBeenCalledWith(
      'u1',
      { id: 'orphan1' },
      expect.objectContaining({ origin: 'connector' })
    );
    // Reclaimed bytes are refunded per owner, from what deleteFabFile reported.
    expect(h.groupStorageDeltaByOwner).toHaveBeenCalledWith([{ id: 'orphan1', userId: 'u1', fileSize: 100 }], -1);
    expect(h.bestEffortAdjustOwnerStorage).toHaveBeenCalled();
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', orgAOwner);
  });

  it('does NOT sweep orphans while member slices remain, so it never revokes over a half-purged set', async () => {
    h.findFiles.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => file(`f${i}`)));
    await run();
    expect(h.findOrphans).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
  });

  it('keeps a shared orphan alive and still releases', async () => {
    h.findOrphans.mockResolvedValue([orphan({ id: 'o-shared', users: [{ userId: 'bob', permissions: 'read' }] })]);
    await run();
    expect(h.deleteFabFile).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', orgAOwner);
  });

  it('rethrows an orphan delete failure without releasing, so the retry re-sweeps the rest', async () => {
    h.findOrphans.mockResolvedValue([orphan()]);
    h.deleteFabFile.mockRejectedValueOnce(new Error('delete blip'));
    await expect(run()).rejects.toThrow('delete blip');
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
  });

  it('rethrows a purge failure without releasing, so the redelivery (then the DLQ) still finds the row', async () => {
    h.findFiles.mockResolvedValue([file('f1')]);
    h.purge.mockRejectedValueOnce(new Error('storage.delete blip'));
    await expect(run()).rejects.toThrow('storage.delete blip');
    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
  });

  it('rethrows a release failure so the message is retried', async () => {
    h.releaseDriveConnection.mockRejectedValueOnce(new Error('revoke blip'));
    await expect(run()).rejects.toThrow('revoke blip');
  });

  it('releases when no member files remain, having checked for orphans (e.g. a redelivery after the last slice)', async () => {
    await run();
    expect(h.purge).not.toHaveBeenCalled();
    // With no members left the orphan sweep still runs, finds none, and releases.
    expect(h.findOrphans).toHaveBeenCalledWith('conn1', 'datalake:lake1');
    expect(h.deleteFabFile).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', orgAOwner);
  });

  it('releases when the lake itself is already gone (its own purge swept the files)', async () => {
    h.dlFindById.mockResolvedValue(null);
    await run();
    expect(h.findFiles).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', orgAOwner);
  });

  it.each([
    ['the connection was already released', null],
    ['the lake now has a different connection', { ...pendingConn, id: 'conn2' }],
    ['the connection belongs to another org', { ...pendingConn, organizationId: 'orgB' }],
    ['no disconnect is pending on it', { ...pendingConn, disconnectRequestedAt: undefined }],
  ])('drops the message when %s', async (_label, conn) => {
    h.connFindByDataLakeIdAny.mockResolvedValue(conn);
    await run();
    expect(h.connMarkDisconnecting).not.toHaveBeenCalled();
    expect(h.purge).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
  });

  it('defers behind a sync that slipped in, instead of purging past it', async () => {
    h.connMarkDisconnecting.mockResolvedValue(null);
    await run();
    expect(h.findFiles).not.toHaveBeenCalled();
    expect(h.sendToQueue).toHaveBeenCalledWith('purge-queue-url', { ...payload, syncDeferrals: 1 }, 300);
    // Keeps the stall clock fresh, so the UI does not offer a retry on a chain that is still live.
    expect(h.connTouchDisconnect).toHaveBeenCalledWith('conn1', orgAOwner);
  });

  it('gives up into the DLQ once the sync deferrals are exhausted', async () => {
    h.connMarkDisconnecting.mockResolvedValue(null);
    await expect(run({ ...payload, syncDeferrals: 12 })).rejects.toThrow(/blocked by a sync/);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['a wrong-shaped payload', JSON.stringify({ connectionId: 'conn1' })],
  ])('swallows %s rather than retrying it into the DLQ', async (_label, body) => {
    await expect(dispatch({ Records: [{ body }] } as never, {} as never, logger)).resolves.toBeUndefined();
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });
});
