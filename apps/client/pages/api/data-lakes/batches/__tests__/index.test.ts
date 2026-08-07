import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deliberately does NOT mock @bike4mind/services - reconcileStuckTaxonomy/reconcileStuckBatches
// run for real, so this test actually exercises the guarded-transition decision, not just
// which mock got called. Only the repository layer (@bike4mind/database) and AWS-touching
// modules are mocked.
const h = vi.hoisted(() => ({
  findActiveByUserId: vi.fn(),
  findActiveTaxonomyByUserId: vi.fn(),
  findTaxonomyAttentionByUserId: vi.fn(),
  setTaxonomyStatusIfActive: vi.fn(),
  markTerminalIfActive: vi.fn(),
  dlFindById: vi.fn(),
  dlSetStats: vi.fn(),
  computeDataLakeStats: vi.fn(),
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
      setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive,
      markTerminalIfActive: h.markTerminalIfActive,
    },
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById, setStats: h.dlSetStats },
    fabFileRepository: { ...actual.fabFileRepository, computeDataLakeStats: h.computeDataLakeStats },
  };
});

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
    h.setTaxonomyStatusIfActive.mockResolvedValue({ ...staleBatch, taxonomyStatus: 'failed' });

    const { res } = makeRes();
    await run(res);

    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledWith(
      'stale1',
      expect.arrayContaining(['queued', 'analyzing', 'applying']),
      'failed',
      expect.objectContaining({ taxonomyError: expect.any(String) })
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

    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });
});
