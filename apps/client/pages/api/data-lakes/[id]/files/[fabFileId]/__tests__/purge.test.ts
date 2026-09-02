import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

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
  storageDelete: vi.fn(async () => {}),
  shredMemoryFromSource: vi.fn(async () => 2),
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
  memoryLedgerRepository: {},
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
  changeStorageSize: h.changeStorageSize,
  withTransaction: (fn: (session: unknown) => unknown) => fn({}),
  User: { findById: h.userFindById },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ delete: h.storageDelete }) }));
vi.mock('@server/utils/auditLog', () => ({
  logAuditEvent: h.logAuditEvent,
  DataLakeAuditEvents: { LAKE_DOCUMENT_PURGED: 'LAKE_DOCUMENT_PURGED' },
}));
vi.mock('@server/dataLakes/recomputeStatsForLakeTags', () => ({
  recomputeStatsForLakeTags: h.recomputeStatsForLakeTags,
}));
vi.mock('@server/memory/ledgerMemoryStore', () => ({ shredMemoryFromSource: h.shredMemoryFromSource }));
vi.mock('sst', () => ({ Resource: { SECRET_ENCRYPTION_KEY: { value: 'test-secret-encryption-key' } } }));

import handler from '../purge';

// A real ObjectId: the route refuses a malformed file id ahead of the service, so a stub like 'f1'
// would 400 before any of these cases ran.
const FILE_ID = '65f0a1b2c3d4e5f6a7b8c9d0';

const RECEIPT = {
  dataLakeId: 'lake-oid-1',
  datalakeTag: 'datalake:sales',
  fabFileId: FILE_ID,
  fileName: 'q3.pdf',
  chunksBefore: 3,
  chunksRemaining: 0,
  embeddingModels: ['text-embedding-3-small'],
  documentDeleted: true,
  storageObjectDeleted: true,
  storageObjectsTotal: 1,
  storageObjectsRemaining: 0,
  retrievalIndexOutcome: 'collocated',
  verified: true,
  purgedAt: '2026-01-01T00:00:00.000Z',
  fileCount: 4,
  totalSizeBytes: 900,
};

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (query: Record<string, string>, auth?: { user?: { id: string }; apiKeyInfo?: { keyId: string } }) =>
  ({
    method: 'POST',
    query,
    user: auth?.user ?? { id: 'u1' },
    apiKeyInfo: auth?.apiKeyInfo,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('POST /api/data-lakes/[id]/files/[fabFileId]/purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake', datalakeTag: 'datalake:sales' });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    // The real service files the receipt through `onReceipt` before returning; the mock has to do
    // the same or the route's audit wiring goes untested.
    h.purgeDataLakeDocument.mockImplementation(async (...args: unknown[]) => {
      const adapters = args[3] as { onReceipt?: (r: unknown) => Promise<void> };
      await adapters.onReceipt?.(RECEIPT);
      return RECEIPT;
    });
    h.userFindById.mockReturnValue({ session: () => ({ save: h.userSave }) });
  });

  /** Drive the service's post-destruction hook the way the service itself would. */
  const runOnPurged = async (purged: { ownerUserId: string; fileSize: number; tagNames: string[] }) => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);
    await h.purgeDataLakeDocument.mock.calls[0][3].onPurged(purged);
  };

  it('purges against the RESOLVED lake and returns the receipt verbatim', async () => {
    // The route accepts an id OR a slug; handing the service the raw query value would address
    // the wrong lake for a slug - and here that means destroying the wrong file.
    const { res, json } = makeRes();
    await call(req({ id: 'my-lake', fabFileId: FILE_ID }), res);

    expect(h.purgeDataLakeDocument).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake-oid-1',
      FILE_ID,
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(RECEIPT);
  });

  it('gates on grants like the reversible sibling, rather than encoding half the rule by omission', async () => {
    // A narrower gate here than on DELETE would 404 a grant-based reader on the destructive door
    // only, and drop the org-admin rung the service is allowed to apply.
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: ['org-1'] });
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);

    expect(h.assertLakeAccess.mock.calls[0][2].db.dataLakeAccessGrants).toBeDefined();
    expect(h.purgeDataLakeDocument.mock.calls[0][0]).toEqual({
      userId: 'u1',
      isAdmin: false,
      administeredOrgIds: ['org-1'],
    });
    expect(h.purgeDataLakeDocument.mock.calls[0][3].db.dataLakeAccessGrants).toBeDefined();
  });

  it('spreads lakeConfigAuditDb into the db it wires, like every other lake config-write route', async () => {
    // Without this, a draft-or-legacy lake that auto-activates as a side effect of a purge (see
    // recomputeLakeStats) records no config-change event: the same silent gap every other route on
    // this surface closes by spreading the same constant.
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);

    const db = h.purgeDataLakeDocument.mock.calls[0][3].db;
    expect(db.lakeConfigChangeEvents).toBeDefined();
    expect(db.adminSettings).toBeDefined();
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
    // That lake's own tag is dropped here - the service already rebuilt it to build the receipt,
    // so leaving it in would run a second identical aggregation on every purge.
    await runOnPurged({ ownerUserId: 'owner-9', fileSize: 10, tagNames: ['datalake:sales', 'datalake:archive'] });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalledWith(
      ['datalake:archive'],
      expect.objectContaining({ actor: { userId: 'u1', isAdmin: false } })
    );
  });

  it('drops the purged lake from the rebuild whatever the case of its tag', async () => {
    await runOnPurged({ ownerUserId: 'owner-9', fileSize: 10, tagNames: ['DataLake:Sales'] });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalledWith([], expect.anything());
  });

  it('still rebuilds the other lakes when the quota write fails', async () => {
    // The destruction has already committed; a quota hiccup must not skip the rest of the cleanup.
    h.changeStorageSize.mockRejectedValueOnce(new Error('mongo down'));
    await runOnPurged({ ownerUserId: 'owner-9', fileSize: 27707, tagNames: ['datalake:sales'] });

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalled();
  });

  it('writes a durable audit event carrying the receipt', async () => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);

    expect(h.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'LAKE_DOCUMENT_PURGED',
        metadata: expect.objectContaining({ fabFileId: FILE_ID, verified: true, chunksBefore: 3 }),
      }),
      expect.anything()
    );
  });

  it('names the KEY, not its owner, when a b4m_live_ key drives the destruction', async () => {
    // `baseApi()` sets no requiredScopes here, so any valid key reaches the most destructive door
    // in the lake surface. The row is immutable and floor-retained for 450 days: attributing a
    // key-driven destroy to the human as though they did it by hand cannot be corrected later.
    const { res } = makeRes();
    await call(
      req({ id: 'lake-oid-1', fabFileId: FILE_ID }, { user: { id: 'u1' }, apiKeyInfo: { keyId: 'key-abc' } }),
      res
    );

    expect(h.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          principalKind: 'apiKey',
          principalId: 'key-abc',
          onBehalfOfUserId: 'u1',
        }),
      }),
      expect.anything()
    );
  });

  it('names the human on a session-driven destruction', async () => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);

    expect(h.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ principalKind: 'user', principalId: 'u1' }),
      }),
      expect.anything()
    );
  });

  it('records an unverified sweep as unverified rather than as a success', async () => {
    const unverified = { ...RECEIPT, chunksRemaining: 2, verified: false };
    h.purgeDataLakeDocument.mockImplementation(async (...args: unknown[]) => {
      const adapters = args[3] as { onReceipt?: (r: unknown) => Promise<void> };
      await adapters.onReceipt?.(unverified);
      return unverified;
    });
    const { res, json } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);

    expect(h.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ verified: false, chunksRemaining: 2 }) }),
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ verified: false }));
  });

  it('wires the retrieval index only where vectors live outside the chunk store', async () => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);
    expect(h.purgeDataLakeDocument.mock.calls[0][3].retrievalIndex).toBeUndefined();

    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);
    expect(h.purgeDataLakeDocument.mock.calls[1][3].retrievalIndex).toBeDefined();
  });

  it('tells the service which of the two reasons there is no retrieval index', async () => {
    // A bare `undefined` cannot distinguish collocated vectors from a door left unwired, and the
    // receipt is persisted into every audit row.
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);
    expect(h.purgeDataLakeDocument.mock.calls[0][3].vectorsCollocated).toBe(true);

    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);
    expect(h.purgeDataLakeDocument.mock.calls[1][3].vectorsCollocated).toBe(false);
  });

  it('wires the object store, so the refunded bytes are bytes that really went', async () => {
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);
    expect(h.purgeDataLakeDocument.mock.calls[0][3].storage).toBeDefined();
  });

  it('files an unverified audit record when the sweep throws mid-destruction', async () => {
    // The writes are not transactional: a throw can leave a destroyed document behind, and an
    // irreversible destruction with no durable record is the exact failure the receipt exists for.
    h.purgeDataLakeDocument.mockRejectedValue(new Error('mongo down'));
    const { res } = makeRes();

    await expect(
      call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }, { user: { id: 'u1' }, apiKeyInfo: { keyId: 'key-abc' } }), res)
    ).rejects.toThrow('mongo down');
    expect(h.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LAKE_DOCUMENT_PURGED',
        // The throw path needs the principal as much as the success path - more, since this is the
        // row for a destruction whose extent nobody knows.
        metadata: expect.objectContaining({
          fabFileId: FILE_ID,
          verified: false,
          error: 'mongo down',
          principalKind: 'apiKey',
          principalId: 'key-abc',
        }),
      }),
      expect.anything()
    );
  });

  it('does not file an audit record for a request the service refused', async () => {
    // A refusal destroyed nothing, so an audit row for it would be noise rather than evidence.
    const { BadRequestError } = await import('@bike4mind/utils');
    h.purgeDataLakeDocument.mockRejectedValue(new BadRequestError('Only the owner'));
    const { res } = makeRes();

    await expect(call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res)).rejects.toThrow('Only the owner');
    expect(h.logAuditEvent).not.toHaveBeenCalled();
  });

  it('refuses a malformed file id before the service runs, and files nothing', async () => {
    // `findById` hands a bad id straight to Mongoose, which throws a CastError - not one of the
    // gate errors - so without this check the catch would file an unverified-purge row for a
    // request that never wrote anything.
    const { res } = makeRes();
    await expect(call(req({ id: 'lake-oid-1', fabFileId: 'not-an-oid' }), res)).rejects.toThrow('Invalid file id');
    expect(h.purgeDataLakeDocument).not.toHaveBeenCalled();
    expect(h.logAuditEvent).not.toHaveBeenCalled();
  });

  it('marks a throw AFTER the receipt as post-destruction, not as a failed sweep', async () => {
    // Both file `verified: false`, and an auditor has to be able to tell an intact document from
    // one that is genuinely gone with only the bookkeeping left undone.
    h.purgeDataLakeDocument.mockImplementation(async (...args: unknown[]) => {
      const adapters = args[3] as { onReceipt?: (r: unknown) => Promise<void> };
      await adapters.onReceipt?.(RECEIPT);
      throw new Error('quota update failed');
    });
    const { res } = makeRes();

    await expect(call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res)).rejects.toThrow('quota update failed');
    expect(h.logAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ verified: false, phase: 'post-destruction' }),
      }),
      expect.anything()
    );
  });

  it('marks a throw before the receipt as a failed sweep', async () => {
    h.purgeDataLakeDocument.mockRejectedValue(new Error('mongo down'));
    const { res } = makeRes();

    await expect(call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res)).rejects.toThrow('mongo down');
    expect(h.logAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ verified: false, phase: 'sweep' }) }),
      expect.anything()
    );
  });

  it('caps the error text filed on a throw, so a long or unbounded message cannot ride into the no-TTL row', async () => {
    h.purgeDataLakeDocument.mockRejectedValue(new Error('x'.repeat(1000)));
    const { res } = makeRes();

    await expect(call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res)).rejects.toThrow();
    const metadata = h.logAuditEvent.mock.calls[0][0].metadata;
    expect(metadata.error).toHaveLength(500);
  });

  it('does not file an audit record for a NotFound refusal either', async () => {
    const { NotFoundError } = await import('@bike4mind/utils');
    h.purgeDataLakeDocument.mockRejectedValue(new NotFoundError('File not found in this data lake'));
    const { res } = makeRes();

    await expect(call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res)).rejects.toThrow('File not found');
    expect(h.logAuditEvent).not.toHaveBeenCalled();
  });

  it('refuses a lake the caller cannot even see, before touching anything', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();
    await expect(call(req({ id: 'nope', fabFileId: FILE_ID }), res)).rejects.toThrow('Data lake not found');
    expect(h.purgeDataLakeDocument).not.toHaveBeenCalled();
  });
  it('keeps the destroyed file name out of the audit row, which is retained forever', async () => {
    // CounterLog has no TTL, so anything spread into the metadata outlives the destruction it
    // records - and a file name can itself be the sensitive fact. The hash keeps the row
    // correlatable without retaining what the document was called.
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);

    const metadata = h.logAuditEvent.mock.calls[0][0].metadata;
    expect(metadata).not.toHaveProperty('fileName');
    expect(metadata.fileNameHash).toBe(
      createHmac('sha256', 'test-secret-encryption-key').update('q3.pdf').digest('hex')
    );
    expect(metadata).toMatchObject({ fabFileId: FILE_ID, verified: true, chunksBefore: 3 });
  });

  it('shreds the facts the lake distilled from the purged document', async () => {
    // Extracted beliefs keep reaching live system prompts through recallLakeMemory, so a document
    // reported permanently deleted would otherwise go on speaking through them.
    const { res } = makeRes();
    await call(req({ id: 'lake-oid-1', fabFileId: FILE_ID }), res);

    await h.purgeDataLakeDocument.mock.calls[0][3].shredDocumentMemory({
      datalakeTag: 'datalake:sales',
      ownerUserId: 'owner-1',
      fabFileId: FILE_ID,
    });

    expect(h.shredMemoryFromSource).toHaveBeenCalledWith(
      {},
      { kind: 'lake', id: 'datalake:sales' },
      'owner-1',
      FILE_ID
    );
  });
});
