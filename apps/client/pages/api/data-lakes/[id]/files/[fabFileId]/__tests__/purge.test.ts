import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  purgeDataLakeDocument: vi.fn(),
  openSearchRetrievalIndex: vi.fn(() => ({ removeForDataLake: vi.fn() })),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  selfHostOpenSearchEnabled: vi.fn(() => false),
  logAuditEvent: vi.fn(async () => {}),
  recomputeStatsForLakeTags: vi.fn(async () => {}),
  changeStorageSize: vi.fn(async () => {}),
  userSave: vi.fn(async () => {}),
  userFindById: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    purgeDataLakeDocument: h.purgeDataLakeDocument,
    openSearchRetrievalIndex: h.openSearchRetrievalIndex,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  fabFileChunkRepository: {},
  sessionRepository: {},
  changeStorageSize: h.changeStorageSize,
  withTransaction: (fn: (session: unknown) => unknown) => fn({}),
  User: { findById: h.userFindById },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/auditLog', () => ({
  logAuditEvent: h.logAuditEvent,
  DataLakeAuditEvents: { LAKE_DOCUMENT_PURGED: 'LAKE_DOCUMENT_PURGED' },
}));
vi.mock('@server/dataLakes/recomputeStatsForLakeTags', () => ({
  recomputeStatsForLakeTags: h.recomputeStatsForLakeTags,
}));

import handler from '../purge';

const RECEIPT = {
  dataLakeId: 'lake-oid-1',
  datalakeTag: 'datalake:sales',
  fabFileId: 'f1',
  fileName: 'q3.pdf',
  chunksBefore: 3,
  chunksRemaining: 0,
  embeddingModels: ['text-embedding-3-small'],
  documentDeleted: true,
  retrievalIndexPurged: false,
  verified: true,
  purgedAt: '2026-01-01T00:00:00.000Z',
  fileCount: 4,
  totalSizeBytes: 900,
};

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (query: Record<string, string>) =>
  ({ method: 'POST', query, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('POST /api/data-lakes/[id]/files/[fabFileId]/purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    h.purgeDataLakeDocument.mockResolvedValue(RECEIPT);
    h.userFindById.mockReturnValue({ session: () => ({ save: h.userSave }) });
  });

  /** Drive the service's post-destruction hook the way the service itself would. */
  const runOnPurged = async (purged: { ownerUserId: string; fileSize: number; tagNames: string[] }) => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: 'f1' }), res);
    await h.purgeDataLakeDocument.mock.calls[0][3].onPurged(purged);
  };

  it('purges against the RESOLVED lake and returns the receipt verbatim', async () => {
    // The route accepts an id OR a slug; handing the service the raw query value would address
    // the wrong lake for a slug - and here that means destroying the wrong file.
    const { res, json } = makeRes();
    await call(req({ id: 'my-lake', fabFileId: 'f1' }), res);

    expect(h.purgeDataLakeDocument).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake-oid-1',
      'f1',
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(RECEIPT);
  });

  it('gates on grants like the reversible sibling, rather than encoding half the rule by omission', async () => {
    // A narrower gate here than on DELETE would 404 a grant-based reader on the destructive door
    // only, and drop the org-admin rung the service is allowed to apply.
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: ['org-1'] });
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: 'f1' }), res);

    expect(h.assertLakeAccess.mock.calls[0][2].db.dataLakeAccessGrants).toBeDefined();
    expect(h.purgeDataLakeDocument.mock.calls[0][0]).toEqual({
      userId: 'u1',
      isAdmin: false,
      administeredOrgIds: ['org-1'],
    });
    expect(h.purgeDataLakeDocument.mock.calls[0][3].db.dataLakeAccessGrants).toBeDefined();
  });

  it("returns the destroyed bytes to the FILE OWNER's quota, not the caller's", async () => {
    await runOnPurged({ ownerUserId: 'owner-9', fileSize: 27707, tagNames: [] });

    expect(h.userFindById).toHaveBeenCalledWith('owner-9');
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.anything(), -27707);
  });

  it('touches no quota when the row stored no bytes', async () => {
    await runOnPurged({ ownerUserId: 'owner-9', fileSize: 0, tagNames: [] });
    expect(h.changeStorageSize).not.toHaveBeenCalled();
  });

  it('rebuilds the stats of every OTHER lake that held the document', async () => {
    // The service recomputes only the lake purged from; without this the others count it forever.
    await runOnPurged({ ownerUserId: 'owner-9', fileSize: 10, tagNames: ['datalake:sales', 'datalake:archive'] });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalledWith(
      ['datalake:sales', 'datalake:archive'],
      expect.objectContaining({ actor: { userId: 'u1', isAdmin: false } })
    );
  });

  it('still rebuilds the other lakes when the quota write fails', async () => {
    // The destruction has already committed; a quota hiccup must not skip the rest of the cleanup.
    h.changeStorageSize.mockRejectedValueOnce(new Error('mongo down'));
    await runOnPurged({ ownerUserId: 'owner-9', fileSize: 27707, tagNames: ['datalake:sales'] });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalled();
  });

  it('writes a durable audit event carrying the receipt', async () => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: 'f1' }), res);

    expect(h.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'LAKE_DOCUMENT_PURGED',
        metadata: expect.objectContaining({ fabFileId: 'f1', verified: true, chunksBefore: 3 }),
      }),
      expect.anything()
    );
  });

  it('records an unverified sweep as unverified rather than as a success', async () => {
    h.purgeDataLakeDocument.mockResolvedValue({ ...RECEIPT, chunksRemaining: 2, verified: false });
    const { res, json } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: 'f1' }), res);

    expect(h.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ verified: false, chunksRemaining: 2 }) }),
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ verified: false }));
  });

  it('wires the retrieval index only where vectors live outside the chunk store', async () => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: 'f1' }), res);
    expect(h.purgeDataLakeDocument.mock.calls[0][3].retrievalIndex).toBeUndefined();

    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    await call(req({ id: 'lake-oid-1', fabFileId: 'f1' }), res);
    expect(h.purgeDataLakeDocument.mock.calls[1][3].retrievalIndex).toBeDefined();
  });

  it('refuses a lake the caller cannot even see, before touching anything', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();
    await expect(call(req({ id: 'nope', fabFileId: 'f1' }), res)).rejects.toThrow('Data lake not found');
    expect(h.purgeDataLakeDocument).not.toHaveBeenCalled();
  });
});
