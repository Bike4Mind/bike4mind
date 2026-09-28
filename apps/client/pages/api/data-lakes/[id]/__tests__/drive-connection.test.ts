import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test of the per-lake Drive connection status/disconnect route (D2). Repo + auth gate mocked.
const h = vi.hoisted(() => ({
  verifyOrgAccess: vi.fn(),
  dlFindById: vi.fn(),
  connFindByDataLakeIdAny: vi.fn(),
  connDisableIfNotSyncing: vi.fn(async () => true),
  releaseDriveConnection: vi.fn(),
  shredMemoryForLakeTags: vi.fn(),
  fabFilesFindByDriveConnectionIdInDataLake: vi.fn(async () => []),
  fabFilesCountByDriveConnectionIdInDataLake: vi.fn(async () => 0),
  purgeDataLakeConnectionFiles: vi.fn(async () => ({ filesPurged: 0, storageObjectsDeleted: 0 })),
  recomputeLakeStats: vi.fn(async () => ({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
// The route's job is the gate + delegation; the revoke-then-delete seam has its own unit test
// (server/integrations/google/drive/releaseDriveConnection.test.ts).
vi.mock('@server/integrations/google/drive/common', () => ({
  releaseDriveConnection: h.releaseDriveConnection,
}));
// The per-document lake-memory shred has its own coverage (shredMemoryForLakeTags's unit tests);
// this route's job is wiring the call, so it is stubbed here.
vi.mock('@server/dataLakes/shredMemoryForLakeTags', () => ({ shredMemoryForLakeTags: h.shredMemoryForLakeTags }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    orgGoogleDriveConnectionRepository: {
      ...actual.orgGoogleDriveConnectionRepository,
      findByDataLakeIdAny: h.connFindByDataLakeIdAny,
      disableIfNotSyncing: h.connDisableIfNotSyncing,
    },
    fabFileRepository: {
      ...actual.fabFileRepository,
      findByDriveConnectionIdInDataLake: h.fabFilesFindByDriveConnectionIdInDataLake,
      countByDriveConnectionIdInDataLake: h.fabFilesCountByDriveConnectionIdInDataLake,
    },
  };
});
// The content sweep itself (files/chunks/index/storage) has its own coverage
// (purgeDataLakeConnectionFiles's unit tests + the connection-content e2e suite); this route's job
// is the gate + delegation, so the sweep is stubbed here.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    purgeDataLakeConnectionFiles: h.purgeDataLakeConnectionFiles,
    lakeMembershipScope: (lake: unknown) => lake,
    openSearchRetrievalIndex: vi.fn(),
    recomputeLakeStats: h.recomputeLakeStats,
  },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
// NOT mocked: @bike4mind/database's own models import from @bike4mind/db-core internally, so
// replacing the whole module here breaks unrelated imports it needs. selfHostOpenSearchEnabled
// just reads env vars and is false by default in this test environment, which is the branch this
// suite wants anyway (no self-host OpenSearch retrieval index to wire).
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ delete: vi.fn() }) }));

import handler from '../drive-connection';

const makeRes = () => {
  const json = vi.fn();
  const send = vi.fn();
  const status = vi.fn(() => ({ json, send }));
  return { res: { json, send, status } as never, json, send, status };
};
const makeReq = (method: string) => ({ method, query: { id: 'lake1' }, user: { id: 'u1', isAdmin: false } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('/api/data-lakes/[id]/drive-connection (D2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', datalakeTag: 'datalake:lake1' });
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.fabFilesFindByDriveConnectionIdInDataLake.mockResolvedValue([]);
    h.fabFilesCountByDriveConnectionIdInDataLake.mockResolvedValue(0);
    h.connDisableIfNotSyncing.mockResolvedValue(true);
  });

  it('GET returns a credential-free connection view, with how many files it ingested', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      driveFolderId: 'Folder123',
      folderName: 'Docs',
      status: 'connected',
      enabled: true,
      oauthRefreshToken: 'SHOULD-NOT-LEAK',
    });
    h.fabFilesCountByDriveConnectionIdInDataLake.mockResolvedValue(5);
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);

    const payload = json.mock.calls[0][0];
    expect(payload.connection).toMatchObject({
      id: 'conn1',
      driveFolderId: 'Folder123',
      folderName: 'Docs',
      status: 'connected',
      fileCount: 5,
    });
    expect(JSON.stringify(payload)).not.toContain('SHOULD-NOT-LEAK');
    expect(h.fabFilesCountByDriveConnectionIdInDataLake).toHaveBeenCalledWith('conn1', 'datalake:lake1');
  });

  it('GET returns null when no connection feeds the lake', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue(null);
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json).toHaveBeenCalledWith({ connection: null });
  });

  it('DELETE releases the connection through the revoking seam, purges its ingested files, recomputes stats, and 204s', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
    h.releaseDriveConnection.mockResolvedValue(true);
    const files = [{ id: 'f1', userId: 'u1', fileSize: 10, filePath: 'p1', versions: [] }];
    h.fabFilesFindByDriveConnectionIdInDataLake.mockResolvedValue(files);
    const calls: string[] = [];
    h.connDisableIfNotSyncing.mockImplementationOnce(async () => (calls.push('disable'), true));
    h.purgeDataLakeConnectionFiles.mockImplementationOnce(
      async () => (calls.push('purge'), { filesPurged: 1, storageObjectsDeleted: 1 })
    );
    h.recomputeLakeStats.mockImplementationOnce(
      async () => (calls.push('recompute'), { fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 })
    );
    h.releaseDriveConnection.mockImplementationOnce(async () => (calls.push('release'), true));
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    // Not the bare repo delete: going through the seam is what revokes the Google grant, so a
    // disconnect cannot leave a live grant behind a deleted row.
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', 'orgA');
    expect(status).toHaveBeenCalledWith(204);
    // The gate + release are scoped to the LAKE's org, never a caller-supplied one.
    expect(h.verifyOrgAccess).toHaveBeenCalledWith(expect.anything(), 'orgA');
    // Every FabFile the disconnected connection ingested must be swept, not just the connection row.
    expect(h.fabFilesFindByDriveConnectionIdInDataLake).toHaveBeenCalledWith('conn1', 'datalake:lake1');
    expect(h.purgeDataLakeConnectionFiles).toHaveBeenCalledWith(expect.anything(), files, expect.anything());
    // Disable-then-purge-then-recompute-then-release: the row must outlive a failed purge
    // (retriable), the poll must not be able to re-enqueue this connection while the purge is
    // running, and the lake's persisted stats must reflect the sweep before the row goes.
    expect(calls).toEqual(['disable', 'purge', 'recompute', 'release']);
  });

  it('DELETE wires a shredDocumentMemory callback that shreds the purged file against this lake', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
    h.releaseDriveConnection.mockResolvedValue(true);
    h.dlFindById.mockResolvedValue({
      id: 'lake1',
      organizationId: 'orgA',
      datalakeTag: 'datalake:lake1',
      createdByUserId: 'owner1',
    });
    h.fabFilesFindByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'f1', userId: 'u1', fileSize: 10, filePath: 'p1', versions: [], tags: [{ name: 'datalake:lake1' }] },
    ]);
    h.purgeDataLakeConnectionFiles.mockImplementationOnce(async (_scope, _files, adapters) => {
      // Exercise the callback the route wired, the same way the real sweep would call it per file.
      await adapters.shredDocumentMemory({ tagNames: ['datalake:lake1'], fabFileId: 'f1', ownerUserId: 'u1' });
      return { filesPurged: 1, storageObjectsDeleted: 1 };
    });
    const { res } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.shredMemoryForLakeTags).toHaveBeenCalledWith(
      ['datalake:lake1'],
      'f1',
      'u1',
      { id: 'lake1', datalakeTag: 'datalake:lake1', createdByUserId: 'owner1' },
      expect.anything()
    );
  });

  it('DELETE leaves the connection row intact when the content purge throws, so a retry can still find it', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
    h.fabFilesFindByDriveConnectionIdInDataLake.mockResolvedValue([
      { id: 'f1', userId: 'u1', fileSize: 10, filePath: 'p1', versions: [] },
    ]);
    h.purgeDataLakeConnectionFiles.mockRejectedValueOnce(new Error('storage.delete blip'));
    const { res } = makeRes();
    await expect(run(makeReq('DELETE'), res)).rejects.toThrow('storage.delete blip');
    expect(h.connDisableIfNotSyncing).toHaveBeenCalledWith('conn1');
    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
  });

  it('DELETE skips the content sweep call when the connection ingested no files', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
    h.releaseDriveConnection.mockResolvedValue(true);
    h.fabFilesFindByDriveConnectionIdInDataLake.mockResolvedValue([]);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.purgeDataLakeConnectionFiles).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(204);
  });

  it('DELETE 204s even when there is nothing to release', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue(null);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
    expect(h.fabFilesFindByDriveConnectionIdInDataLake).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(204);
  });

  it('DELETE 409s (does NOT hard-delete or purge) while a sync is in progress', async () => {
    // Hard-deleting under a live ingest would orphan the running handler's connection while the UI
    // reads "Disconnected"; make the caller wait until the sync finishes (or its claim goes stale).
    // disableIfNotSyncing is the atomic compare-and-set that answers this - not a snapshot read of
    // `conn.status`, which a concurrent claimForSync could race between the read and a bare disable.
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA', status: 'syncing' });
    h.connDisableIfNotSyncing.mockResolvedValue(false);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connDisableIfNotSyncing).toHaveBeenCalledWith('conn1');
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
    expect(h.fabFilesFindByDriveConnectionIdInDataLake).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(409);
  });

  /**
   * The disabled-connection cases. Archiving or soft-deleting a lake flips its connection to
   * `enabled: false`, which is why this route resolves through the enabled-BLIND finder: an
   * enabled-only lookup would report the connection gone while the Google grant stayed live and the
   * globally-unique driveFolderId claim stayed held, so the folder could never be re-claimed by
   * anyone and this endpoint would answer 204 having revoked nothing.
   */
  it('DELETE still revokes for an archived lake whose connection is disabled', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      enabled: false,
      status: 'connected',
    });
    h.releaseDriveConnection.mockResolvedValue(true);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.releaseDriveConnection).toHaveBeenCalledWith('conn1', 'orgA');
    expect(status).toHaveBeenCalledWith(204);
  });

  it('GET reports a disabled connection rather than pretending it is gone', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      id: 'conn1',
      organizationId: 'orgA',
      driveFolderId: 'Folder123',
      status: 'connected',
      enabled: false,
    });
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json.mock.calls[0][0].connection).toMatchObject({ id: 'conn1', enabled: false });
  });

  // Both verbs, because that check is the ONLY thing scoping a deliberately-global finder: with one
  // arm untested it could be dropped from the other for free.
  it.each(['GET', 'DELETE'] as const)(
    '%s 404s a connection whose org does not match the lake, since the finder is global',
    async method => {
      h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgB' });
      const { res } = makeRes();
      await expect(run(makeReq(method), res)).rejects.toThrow(/not found/i);
      expect(h.releaseDriveConnection).not.toHaveBeenCalled();
    }
  );

  it('denies a caller who is not an org owner/manager', async () => {
    h.verifyOrgAccess.mockRejectedValue(new Error('Organization not found'));
    const { res } = makeRes();
    await expect(run(makeReq('GET'), res)).rejects.toThrow(/organization not found/i);
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('GET resolves a null connection for a personal (org-less) lake, rather than 404ing', async () => {
    // A personal lake genuinely has no connection to report - that's "no connection", not a
    // failure, so the client needs to be able to tell it apart from a denied/missing-lake read.
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json).toHaveBeenCalledWith({ connection: null });
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('DELETE 404s a personal (org-less) lake', async () => {
    // DELETE goes through resolveOrgLake, the one path GET no longer exercises since it inlined
    // its own org-less short-circuit - so this is the only remaining coverage of that guard.
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
    const { res } = makeRes();
    await expect(run(makeReq('DELETE'), res)).rejects.toThrow(/not found/i);
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('GET 404s when the lake itself does not exist', async () => {
    h.dlFindById.mockResolvedValue(null);
    const { res } = makeRes();
    await expect(run(makeReq('GET'), res)).rejects.toThrow(/not found/i);
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });
});
