import { describe, it, expect, vi, beforeEach } from 'vitest';

// reconcileStuckTaxonomy/reconcileStuckBatches deliberately run for REAL, so the GET tests
// exercise the guarded-transition decision rather than which mock got called. Only the POST
// path's two lake gates are stubbed (below), plus the repository layer (@bike4mind/database)
// and AWS-touching modules.
const h = vi.hoisted(() => ({
  findActiveByUserId: vi.fn(),
  findActiveTaxonomyByUserId: vi.fn(),
  findTaxonomyAttentionByUserId: vi.fn(),
  forceFailStuckTaxonomy: vi.fn(),
  markTerminalIfActive: vi.fn(),
  batchCreate: vi.fn(),
  dlFindById: vi.fn(),
  dlSetStats: vi.fn(),
  computeDataLakeStats: vi.fn(),
  // The draft -> active flip and the audit row it emits. Stubbed because the real repositories are
  // Mongo-backed: this spec spreads the actual @bike4mind/database module, so anything the audit
  // path reaches has to be overridden or it hangs on a buffering timeout with no connection.
  activateIfDraft: vi.fn(),
  recordConfigChange: vi.fn().mockResolvedValue({}),
  findBySettingNames: vi.fn().mockResolvedValue([]),
  findAll: vi.fn().mockResolvedValue([]),
  assertLakeWriteAccess: vi.fn(),
  assertLakeAdmission: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@server/utils/cloudwatch', () => ({ recordReconcilerForcedTerminal: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  enqueueTaxonomyAnalysisIfWanted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeBatchRepository: {
      ...actual.dataLakeBatchRepository,
      findActiveByUserId: h.findActiveByUserId,
      findActiveTaxonomyByUserId: h.findActiveTaxonomyByUserId,
      findTaxonomyAttentionByUserId: h.findTaxonomyAttentionByUserId,
      forceFailStuckTaxonomy: h.forceFailStuckTaxonomy,
      markTerminalIfActive: h.markTerminalIfActive,
      create: h.batchCreate,
    },
    dataLakeRepository: {
      ...actual.dataLakeRepository,
      findById: h.dlFindById,
      setStats: h.dlSetStats,
      activateIfDraft: h.activateIfDraft,
    },
    fabFileRepository: { ...actual.fabFileRepository, computeDataLakeStats: h.computeDataLakeStats },
    lakeConfigChangeEventRepository: { ...actual.lakeConfigChangeEventRepository, record: h.recordConfigChange },
    adminSettingsRepository: {
      ...actual.adminSettingsRepository,
      findBySettingNames: h.findBySettingNames,
      findAll: h.findAll,
    },
  };
});

// Partial: only the POST path's two lake gates. The reconcilers the GET tests exercise stay real.
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<{ dataLakeService: Record<string, unknown> }>();
  return {
    ...actual,
    dataLakeService: {
      ...actual.dataLakeService,
      assertLakeWriteAccess: h.assertLakeWriteAccess,
      assertLakeAdmission: h.assertLakeAdmission,
    },
  };
});
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async (r: { user: { id: string } }) => ({ userId: r.user.id, isAdmin: false })),
}));

import handler from '../index';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const req = () => ({ method: 'GET', user: { id: 'u1' } }) as never;
const run = (res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(), res);

describe('GET /api/data-lakes/batches - reconciler wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findActiveByUserId.mockResolvedValue([]);
    h.findTaxonomyAttentionByUserId.mockResolvedValue([]);
  });

  it('forces a stale analyzing batch to failed even when it is outside the attention cap', async () => {
    // findTaxonomyAttentionByUserId (the capped/sorted list-response set) does NOT include this
    // batch - simulating exactly the scenario fdbfa17e fixed: a stale batch pushed out of the
    // top-N by recency. findActiveTaxonomyByUserId (the reconciler-input set) DOES include it.
    // If the route regresses to feeding the reconciler from findTaxonomyAttentionByUserId
    // instead, this batch never reaches the guarded transition and the test fails.
    const staleBatch = {
      id: 'stale1',
      userId: 'u1',
      dataLakeId: 'lake1',
      taxonomyStatus: 'analyzing',
      taxonomyStartedAt: new Date(Date.now() - 15 * 60 * 1000), // 15 min ago > 10 min timeout
    };
    h.findActiveTaxonomyByUserId.mockResolvedValue([staleBatch]);
    h.forceFailStuckTaxonomy.mockResolvedValue({ ...staleBatch, taxonomyStatus: 'failed' });

    const { res } = makeRes();
    await run(res);

    expect(h.forceFailStuckTaxonomy).toHaveBeenCalledWith(
      'stale1',
      expect.arrayContaining(['queued', 'analyzing', 'applying']),
      expect.any(Date),
      expect.any(String)
    );
  });

  // The wiring pin for this route's ...lakeConfigAuditDb spread, written as BEHAVIOUR rather than as
  // an assertion on the adapters object: this spec deliberately runs the real reconciler (see the
  // note at the top of the file), so there is no service mock whose arguments could be inspected.
  // Driving the whole path instead is the stronger pin anyway - it fails if the route stops
  // spreading the audit repos, and also if reconcileStuckBatches stops forwarding them onward.
  // Worth pinning here specifically because this reconciler forces terminal exactly the batches that
  // never reached finalizeBatchIfComplete, making it the only path that can ever publish those lakes.
  it('records the auto-activate that forcing a stuck batch terminal causes', async () => {
    const stuckBatch = {
      id: 'stuck1',
      userId: 'u1',
      dataLakeId: 'lake1',
      status: 'processing',
      updatedAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4h idle > the 3h timeout
    };
    h.findActiveByUserId.mockResolvedValue([stuckBatch]);
    h.findActiveTaxonomyByUserId.mockResolvedValue([]);
    h.markTerminalIfActive.mockResolvedValue({ ...stuckBatch, status: 'completed_with_errors' });
    h.dlFindById.mockResolvedValue({
      id: 'lake1',
      datalakeTag: 'datalake:orga:acme',
      fileTagPrefix: 'acme:',
      createdByUserId: 'u1',
      status: 'draft',
    });
    // fileCount > 0 is what makes the flip eligible at all.
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 3, totalSizeBytes: 10, totalChunkedChars: 20 });
    h.activateIfDraft.mockResolvedValue(true);

    const { res } = makeRes();
    await run(res);

    expect(h.recordConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lake1',
        action: 'auto-activate',
        // `system` on both counts by design: no principal drove this, and activateIfDraft
        // authorizes nothing (see recomputeLakeStats).
        principalKind: 'system',
        manageRung: 'system',
        changes: [expect.objectContaining({ field: 'status', before: 'draft', after: 'active' })],
      })
    );
  });

  it('does not force a fresh analyzing batch (still within the timeout)', async () => {
    const freshBatch = {
      id: 'fresh1',
      userId: 'u1',
      dataLakeId: 'lake1',
      taxonomyStatus: 'analyzing',
      taxonomyStartedAt: new Date(),
    };
    h.findActiveTaxonomyByUserId.mockResolvedValue([freshBatch]);

    const { res } = makeRes();
    await run(res);

    expect(h.forceFailStuckTaxonomy).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/batches - admission contract wiring', () => {
  const LAKE = { id: 'lake1', status: 'active', datalakeTag: 'datalake:lake', createdByUserId: 'u1' };
  const postReq = () =>
    ({
      method: 'POST',
      user: { id: 'u1' },
      logger: console,
      body: { dataLakeId: 'lake1', totalFiles: 2, totalSizeBytes: 10 },
    }) as never;
  const runPost = (res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(postReq(), res);

  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeWriteAccess.mockResolvedValue(LAKE);
    h.batchCreate.mockResolvedValue({ id: 'b1' });
  });

  it('grades the lake against the uploader as owner-to-be before creating the batch', async () => {
    // `members` is the contract's only opt-in signal, so an unasserted argument is an unprotected
    // gate: delete it and enforcement silently switches off at this door with nothing else changing.
    const { res } = makeRes();
    await runPost(res);

    expect(h.assertLakeAdmission).toHaveBeenCalledWith([LAKE], [{ userId: 'u1' }], expect.anything());
    expect(h.assertLakeAdmission.mock.invocationCallOrder[0]).toBeLessThan(h.batchCreate.mock.invocationCallOrder[0]);
  });

  it('creates no batch when the contract refuses', async () => {
    // Refusing the BATCH is what makes the refusal legible in the upload UI instead of failing
    // later at presign, so no batch may exist afterwards.
    h.assertLakeAdmission.mockRejectedValue(new Error('refused'));
    const { res } = makeRes();

    await expect(runPost(res)).rejects.toThrow('refused');
    expect(h.batchCreate).not.toHaveBeenCalled();
  });
});
