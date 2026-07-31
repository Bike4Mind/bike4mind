import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  batchFindById: vi.fn(),
  lakeFindById: vi.fn(),
  setTaxonomyStatusIfActive: vi.fn(),
  analyzeBatchTaxonomy: vi.fn(),
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
// No-op rate limiter: the daily-cap policy itself isn't this test's concern.
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));
vi.mock('@server/utils/config', () => ({ isDevelopment: () => false }));
vi.mock('@server/dataLakes/analyzeBatchTaxonomy', () => ({ analyzeBatchTaxonomy: h.analyzeBatchTaxonomy }));
vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { findById: h.batchFindById, setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive },
  dataLakeRepository: { findById: h.lakeFindById },
}));

import handler from '../reanalyze-taxonomy';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const req = (
  batchId: string,
  body: unknown = {},
  user: { id: string; isAdmin: boolean } = { id: 'u1', isAdmin: false }
) => ({ method: 'POST', user, query: { batchId }, body, logger: { error: vi.fn() } }) as never;
const run = (batchId: string, res: unknown, body?: unknown, user?: { id: string; isAdmin: boolean }) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(batchId, body, user), res);

describe('POST /api/data-lakes/batches/[batchId]/reanalyze-taxonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.batchFindById.mockResolvedValue({ id: 'b1', dataLakeId: 'lake1' });
    h.lakeFindById.mockResolvedValue({ id: 'lake1', createdByUserId: 'u1', fileTagPrefix: 'acme:' });
    h.analyzeBatchTaxonomy.mockResolvedValue({
      claimed: true,
      outcome: 'ready',
      batch: { id: 'b1', taxonomyStatus: 'ready' },
    });
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });
  });

  it('rejects a non-owner, non-admin caller before touching the taxonomy phase', async () => {
    h.lakeFindById.mockResolvedValue({ id: 'lake1', createdByUserId: 'someone-else', fileTagPrefix: 'acme:' });
    const { res } = makeRes();

    await expect(run('b1', res)).rejects.toThrow(/creator/i);
    expect(h.analyzeBatchTaxonomy).not.toHaveBeenCalled();
  });

  it('404s for a missing batch or lake', async () => {
    h.batchFindById.mockResolvedValue(null);
    await expect(run('b1', makeRes().res)).rejects.toThrow(/batch not found/i);

    h.batchFindById.mockResolvedValue({ id: 'b1', dataLakeId: 'lake1' });
    h.lakeFindById.mockResolvedValue(null);
    await expect(run('b1', makeRes().res)).rejects.toThrow(/data lake not found/i);
  });

  it('delegates to the shared orchestration with the caller identity, allowed states, and context', async () => {
    const { res } = makeRes();

    await run('b1', res, { context: 'legal docs' });

    expect(h.analyzeBatchTaxonomy).toHaveBeenCalledWith(
      'b1',
      'lake1',
      'u1',
      expect.objectContaining({ error: expect.any(Function) }),
      { from: ['ready', 'failed'], context: 'legal docs' }
    );
  });

  it('refuses when the guarded claim is lost (not currently ready/failed)', async () => {
    h.analyzeBatchTaxonomy.mockResolvedValue({ claimed: false });
    const { res } = makeRes();

    await run('b1', res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns a 400 with the real reason for an anticipated failure (e.g. no API key)', async () => {
    h.analyzeBatchTaxonomy.mockResolvedValue({
      claimed: true,
      outcome: 'failed',
      error: 'No OpenAI API key configured',
    });
    const { res, json } = makeRes();

    await run('b1', res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'No OpenAI API key configured' });
  });

  it('returns the updated batch document on success', async () => {
    const { res, json } = makeRes();

    await run('b1', res);

    expect(json).toHaveBeenCalledWith({ id: 'b1', taxonomyStatus: 'ready' });
  });

  // Unlike the queue handler, there's no SQS retry safety net on this synchronous path -
  // an unexpected error must fail the batch immediately with the real reason rather than
  // leaving it stuck in 'analyzing' until the reconciler's generic timeout kicks in.
  it('reverts the batch to failed with the real error and rethrows on an unexpected exception', async () => {
    const boom = new Error('OpenAI request timed out');
    h.analyzeBatchTaxonomy.mockRejectedValue(boom);
    const { res } = makeRes();

    await expect(run('b1', res)).rejects.toThrow(boom);

    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledWith('b1', ['analyzing'], 'failed', {
      taxonomyError: 'OpenAI request timed out',
    });
  });
});
