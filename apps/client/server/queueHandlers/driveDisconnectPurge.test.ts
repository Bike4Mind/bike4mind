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
  fabFileRepository: { findByDriveConnectionIdInDataLake: h.findFiles },
  fabFileChunkRepository: {},
  dataLakeFindingRepository: {},
  sessionRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    purgeDataLakeConnectionFiles: h.purge,
    lakeMembershipScope: (lake: unknown) => lake,
    openSearchRetrievalIndex: vi.fn(),
    recomputeLakeStats: h.recomputeLakeStats,
  },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('sst', () => ({ Resource: { driveDisconnectPurgeQueue: { url: 'purge-queue-url' } } }));
vi.mock('@server/integrations/google/drive/common', () => ({ releaseDriveConnection: h.releaseDriveConnection }));
vi.mock('@server/dataLakes/shredMemoryForLakeTags', () => ({ shredMemoryForLakeTags: h.shredMemoryForLakeTags }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ delete: vi.fn() }) }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));

import { dispatch } from './driveDisconnectPurge';

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

    expect(h.connMarkDisconnecting).toHaveBeenCalledWith('conn1', 'orgA');
    // includeDeleted, not the reconcile-scoped default, and one slice plus a lookahead row.
    expect(h.findFiles).toHaveBeenCalledWith('conn1', 'datalake:lake1', { includeDeleted: true, limit: 1001 });
    expect(h.purge).toHaveBeenCalledWith(expect.anything(), files, expect.anything());
    const adapters = (h.purge.mock.calls[0] as unknown[])[2] as { db: Record<string, unknown> };
    expect(adapters.db.sessions).toBeDefined();
    expect(adapters.db.dataLakeFindings).toBeDefined();
    // Through the revoking seam, and only once every file is gone: the row is the retry anchor.
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', 'orgA');
    expect(calls).toEqual(['purge', 'recompute', 'release']);
    expect(h.sendToQueue).not.toHaveBeenCalled();
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

  it('releases without calling the sweep when no files remain (e.g. a redelivery after the last slice)', async () => {
    await run();
    expect(h.purge).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', 'orgA');
  });

  it('releases when the lake itself is already gone (its own purge swept the files)', async () => {
    h.dlFindById.mockResolvedValue(null);
    await run();
    expect(h.findFiles).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', 'orgA');
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
    expect(h.connTouchDisconnect).toHaveBeenCalledWith('conn1', 'orgA');
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
