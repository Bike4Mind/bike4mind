import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  incrementCounter: vi.fn(),
  setStatusIfActive: vi.fn(),
  finalizeBatchIfComplete: vi.fn(),
  enqueueTaxonomyAnalysisIfWanted: vi.fn(),
  fabSoftDeleteScoped: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method (same shape as the lifecycle test).
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
vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: {
    findById: h.findById,
    update: h.update,
    incrementCounter: h.incrementCounter,
    setStatusIfActive: h.setStatusIfActive,
  },
  fabFileRepository: {
    softDeleteByIdsForUserBatch: h.fabSoftDeleteScoped,
  },
}));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: h.finalizeBatchIfComplete,
  enqueueTaxonomyAnalysisIfWanted: h.enqueueTaxonomyAnalysisIfWanted,
}));

import handler from '../upload-complete';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const logger = { error: vi.fn(), warn: vi.fn() };
const req = (body: unknown) => ({ method: 'POST', user: { id: 'u1' }, body, logger }) as never;
/** A syntactically valid 24-char hex ObjectId - failedFileIds is shape-validated at the schema. */
const FID_A = '0123456789abcdef01234567';
const run = (body: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(body), res);

describe('POST /api/data-lakes/batches/upload-complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.setStatusIfActive.mockResolvedValue(null);
    h.incrementCounter.mockResolvedValue(null);
    h.update.mockResolvedValue(null);
    h.finalizeBatchIfComplete.mockResolvedValue(undefined);
    h.enqueueTaxonomyAnalysisIfWanted.mockResolvedValue(undefined);
  });

  it('rejects when the batch belongs to another user, without writing anything', async () => {
    h.findById.mockResolvedValue({ id: 'b1', userId: 'someone-else' });
    const { res } = makeRes();

    await expect(run({ batchId: 'b1', failedFiles: 2 }, res)).rejects.toThrow(/batch not found/i);
    expect(h.incrementCounter).not.toHaveBeenCalled();
    expect(h.setStatusIfActive).not.toHaveBeenCalled();
    expect(h.finalizeBatchIfComplete).not.toHaveBeenCalled();
  });

  it('rejects when the batch does not exist, without writing anything', async () => {
    h.findById.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(run({ batchId: 'b1', failedFiles: 2 }, res)).rejects.toThrow(/batch not found/i);
    expect(h.incrementCounter).not.toHaveBeenCalled();
  });

  it('increments failedFiles atomically (never a clobbering set), records names, guards status, finalizes', async () => {
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 3 });
    const { res, json } = makeRes();
    await run({ batchId: 'b1', failedFiles: 2, failedFileNames: ['x', 'y'] }, res);

    // failedFiles must go through the atomic $inc path, not a $set that would clobber
    // a concurrent pipeline increment on the same counter.
    expect(h.incrementCounter).toHaveBeenCalledWith('b1', 'failedFiles', 2);
    expect(h.update).not.toHaveBeenCalledWith(expect.objectContaining({ failedFiles: expect.anything() }));
    // Names are client-only, so a plain set is fine.
    expect(h.update).toHaveBeenCalledWith({ id: 'b1', failedFileNames: ['x', 'y'] });
    // Status transition is guarded so it can't resurrect a finalized batch.
    expect(h.setStatusIfActive).toHaveBeenCalledWith('b1', 'processing');
    expect(h.finalizeBatchIfComplete).toHaveBeenCalledTimes(1);
    // The primary trigger for background AI tagging: fires here regardless of how
    // long chunk/vectorize then takes, not gated on finalizeBatchIfComplete succeeding.
    expect(h.enqueueTaxonomyAnalysisIfWanted).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({ success: true });
  });

  it('enqueues taxonomy analysis with the freshly re-read batch, independent of ingest finalization', async () => {
    const fresh = { id: 'b1', userId: 'u1', totalFiles: 3, wantsTaxonomy: true };
    h.findById.mockResolvedValueOnce({ id: 'b1', userId: 'u1', totalFiles: 3 }).mockResolvedValueOnce(fresh);
    const { res } = makeRes();
    await run({ batchId: 'b1', failedFiles: 0 }, res);

    expect(h.enqueueTaxonomyAnalysisIfWanted).toHaveBeenCalledWith(fresh, expect.anything());
  });

  it('with zero browser failures: skips the increment but still moves to processing + finalizes', async () => {
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 3 });
    const { res } = makeRes();
    await run({ batchId: 'b1', failedFiles: 0 }, res);

    expect(h.incrementCounter).not.toHaveBeenCalled();
    expect(h.setStatusIfActive).toHaveBeenCalledWith('b1', 'processing');
    expect(h.finalizeBatchIfComplete).toHaveBeenCalledTimes(1);
  });

  it('soft-deletes the owned orphan FabFiles BEFORE finalize (so the recompute is honest)', async () => {
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 2 });
    const order: string[] = [];
    h.fabSoftDeleteScoped.mockImplementation(async () => (order.push('delete'), 1));
    h.finalizeBatchIfComplete.mockImplementation(async () => order.push('finalize'));
    const { res } = makeRes();
    await run({ batchId: 'b1', failedFiles: 1, failedFileIds: [FID_A] }, res);

    // The owner AND batch scope must both reach the query - they are the guard, not a refinement
    // (see softDeleteByIdsForUserBatch, whose own tests pin what the filter refuses).
    expect(h.fabSoftDeleteScoped).toHaveBeenCalledWith([FID_A], 'u1', 'b1');
    // The orphan must be gone before finalize recomputes lake stats.
    expect(order).toEqual(['delete', 'finalize']);
  });

  it('does not touch FabFiles at all when the client reports no failed ids', async () => {
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 1 });
    const { res } = makeRes();
    await run({ batchId: 'b1', failedFiles: 1 }, res);

    expect(h.fabSoftDeleteScoped).not.toHaveBeenCalled();
    expect(h.finalizeBatchIfComplete).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed file id at the schema rather than in the cleanup read (#2090)', async () => {
    // Unvalidated, this reached findOne({_id: 'not-an-id'}) and threw a Mongoose CastError, which
    // errorHandler maps to a 404 logged at warn - so it never alerted, and it was raised BEFORE the
    // status flip and finalize below, leaving the batch non-terminal until the stuck reconciler fired.
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 1 });
    const { res } = makeRes();
    // The parse throws a ZodError, which errorHandler renders as a 422. What matters here is that a
    // malformed id can no longer reach the database, so the failure is attributable to the caller.
    await expect(run({ batchId: 'b1', failedFiles: 1, failedFileIds: ['not-an-object-id'] }, res)).rejects.toThrow();

    expect(h.fabSoftDeleteScoped).not.toHaveBeenCalled();
    expect(h.setStatusIfActive).not.toHaveBeenCalled();
    expect(h.finalizeBatchIfComplete).not.toHaveBeenCalled();
  });

  it('clamps an oversized failed-id list instead of rejecting it, so the batch still finalizes (#2090)', async () => {
    // The cap must never cost the batch its terminal state: rejecting the request would discard the
    // failedFiles tally that completion depends on, reproducing the very hang #2090 is about. The
    // ids past the cap simply go uncleaned.
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 1 });
    const { res, json } = makeRes();
    const tooMany = Array.from({ length: 10001 }, () => FID_A);
    await run({ batchId: 'b1', failedFiles: 1, failedFileIds: tooMany }, res);

    expect(h.fabSoftDeleteScoped).toHaveBeenCalledWith(tooMany.slice(0, 10000), 'u1', 'b1');
    // Truncation is silent to the client, so it has to be visible in the logs.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('10001'));
    expect(h.incrementCounter).toHaveBeenCalledWith('b1', 'failedFiles', 1);
    expect(h.setStatusIfActive).toHaveBeenCalledWith('b1', 'processing');
    expect(h.finalizeBatchIfComplete).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({ success: true });
  });

  it('accepts a large failedFileNames list, since a fully-failed presign reports names and no ids', async () => {
    // dataLakeUploadPipeline pushes a name but no id when presign itself is refused, so an append of
    // many files that is refused wholesale arrives here as names only. Bounding them would 422 that
    // request and hang the batch, while buying nothing - they are one $set.
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 5000 });
    const { res, json } = makeRes();
    const names = Array.from({ length: 5000 }, (_, i) => `f${i}.txt`);
    await run({ batchId: 'b1', failedFiles: 5000, failedFileNames: names }, res);

    expect(h.update).toHaveBeenCalledWith({ id: 'b1', failedFileNames: names });
    expect(h.setStatusIfActive).toHaveBeenCalledWith('b1', 'processing');
    expect(h.finalizeBatchIfComplete).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({ success: true });
  });
});
