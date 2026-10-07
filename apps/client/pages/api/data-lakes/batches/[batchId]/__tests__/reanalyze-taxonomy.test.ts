import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  batchFindById: vi.fn(),
  lakeFindById: vi.fn(),
  setTaxonomyStatusIfActive: vi.fn(),
  analyzeBatchTaxonomy: vi.fn(),
  claimBatchForAnalysis: vi.fn(),
  // Order log: serializeLakeClaim's 'enter'/'touch:<lakeId>'/'exit', plus entries the stubs push.
  tx: [] as string[],
  // Real admin-or-creator logic (not a bare stub), matching the sibling lifecycle.test.ts mock,
  // so the manage-gate call behaves identically to production, including the blank-identity case.
  canManageLake: vi.fn(
    (lake: { createdByUserId?: string }, actor: { userId?: string; isAdmin: boolean }) =>
      actor.isAdmin || (!!actor.userId && !!lake.createdByUserId && lake.createdByUserId === actor.userId)
  ),
  loadActiveLakeGrants: vi.fn().mockResolvedValue([]),
  toAccessContext: vi.fn(),
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
vi.mock('@server/dataLakes/analyzeBatchTaxonomy', () => ({
  analyzeBatchTaxonomy: h.analyzeBatchTaxonomy,
  claimBatchForAnalysis: h.claimBatchForAnalysis,
}));
vi.mock('@server/dataLakes/serializeLakeClaim', () => ({
  serializeLakeClaim: async <T extends { lake: { id: string } }>(claim: () => Promise<T>) => {
    h.tx.push('enter');
    try {
      const result = await claim();
      h.tx.push(`touch:${result.lake.id}`);
      return result;
    } finally {
      h.tx.push('exit');
    }
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { findById: h.batchFindById, setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive },
  dataLakeRepository: { findById: h.lakeFindById },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { canManageLake: h.canManageLake, loadActiveLakeGrants: h.loadActiveLakeGrants },
}));
// Real toAccessContext pulls in entitlements/subscription lookups that are out of scope here;
// stub it to the caller identity, same shape the route previously built inline.
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

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
    h.tx.length = 0;
    h.claimBatchForAnalysis.mockImplementation(async () => (h.tx.push('claim'), { id: 'b1' }));
    h.batchFindById.mockResolvedValue({ id: 'b1', dataLakeId: 'lake1' });
    h.lakeFindById.mockResolvedValue({ id: 'lake1', createdByUserId: 'u1', fileTagPrefix: 'acme:' });
    h.analyzeBatchTaxonomy.mockImplementation(async () => {
      h.tx.push('analyze');
      return { claimed: true, outcome: 'ready', batch: { id: 'b1', taxonomyStatus: 'ready' } };
    });
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });
    h.toAccessContext.mockImplementation((req: { user: { id: string; isAdmin: boolean } }) =>
      Promise.resolve({ userId: req.user.id, isAdmin: req.user.isAdmin })
    );
  });

  it('rejects a non-owner, non-admin caller before touching the taxonomy phase', async () => {
    h.lakeFindById.mockResolvedValue({ id: 'lake1', createdByUserId: 'someone-else', fileTagPrefix: 'acme:' });
    const { res } = makeRes();

    await expect(run('b1', res)).rejects.toThrow(/permission/i);
    expect(h.claimBatchForAnalysis).not.toHaveBeenCalled();
    expect(h.analyzeBatchTaxonomy).not.toHaveBeenCalled();
  });

  // The inference call is an external spend a transaction retry would repeat, so only the gate and
  // the claim sit inside; the lake touch is what makes a concurrent revoke collide with the claim.
  it('claims inside the lake-touching transaction and runs the analysis only after it commits', async () => {
    await run('b1', makeRes().res);

    expect(h.tx).toEqual(['enter', 'claim', 'touch:lake1', 'exit', 'analyze']);
  });

  it('now delegates to canManageLake, so a blank-identity lake is rejected rather than granted (#1153)', async () => {
    h.lakeFindById.mockResolvedValue({ id: 'lake1', createdByUserId: '', fileTagPrefix: 'acme:' });
    const { res } = makeRes();

    await expect(run('b1', res, {}, { id: '', isAdmin: false })).rejects.toThrow(/permission/i);
    expect(h.canManageLake).toHaveBeenCalled();
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
      { claimHeldByCaller: true, context: 'legal docs' }
    );
    expect(h.claimBatchForAnalysis).toHaveBeenCalledWith('b1', ['ready', 'failed']);
  });

  it('refuses when the guarded claim is lost (not currently ready/failed)', async () => {
    h.claimBatchForAnalysis.mockResolvedValue(null);
    const { res } = makeRes();

    const thrown: unknown = await run('b1', res).catch((e: unknown) => e);

    expect(thrown).toMatchObject({
      statusCode: 400,
      message: 'This batch is not in a state that can be re-analyzed right now',
    });
    // Thrown inside the callback, so the transaction rolls back instead of committing a lake touch.
    expect(h.tx).toEqual(['enter', 'exit']);
    expect(h.analyzeBatchTaxonomy).not.toHaveBeenCalled();
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
  // an unexpected error must fail the batch immediately rather than leaving it stuck in
  // 'analyzing' until the reconciler's generic timeout kicks in. The stored taxonomyError,
  // the logged message, AND the thrown HTTP error are all the curated message - the raw
  // exception (which errorHandler.ts would otherwise put straight into the response body)
  // never reaches the client, only the logger.
  it('reverts the batch to failed with a curated message, logs the real error, and throws a curated HTTP error (not the raw exception)', async () => {
    const boom = new Error('OpenAI request timed out');
    h.analyzeBatchTaxonomy.mockRejectedValue(boom);
    const { res } = makeRes();
    const request = req('b1');

    const thrown: unknown = await (handler as (req: unknown, res: unknown) => Promise<void>)(request, res).catch(
      (e: unknown) => e
    );

    expect(thrown).toMatchObject({ statusCode: 500, message: 'Re-analysis failed unexpectedly - try again' });
    expect(thrown).not.toBe(boom);
    expect((thrown as Error).message).not.toContain('OpenAI request timed out');
    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledWith('b1', ['analyzing'], 'failed', {
      taxonomyError: 'Re-analysis failed unexpectedly - try again',
    });
    expect((request as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('OpenAI request timed out')
    );
  });

  it('logs (rather than swallows) a failure of the revert-to-failed write itself', async () => {
    const boom = new Error('OpenAI request timed out');
    h.analyzeBatchTaxonomy.mockRejectedValue(boom);
    h.setTaxonomyStatusIfActive.mockRejectedValue(new Error('mongo down'));
    const { res } = makeRes();
    const request = req('b1');

    await (handler as (req: unknown, res: unknown) => Promise<void>)(request, res).catch(() => {});

    expect((request as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('mongo down')
    );
  });
});
