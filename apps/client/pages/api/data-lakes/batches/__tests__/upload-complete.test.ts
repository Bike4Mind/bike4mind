import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  incrementCounter: vi.fn(),
  setStatusIfActive: vi.fn(),
  finalizeBatchIfComplete: vi.fn(),
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
}));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: h.finalizeBatchIfComplete,
}));

import handler from '../upload-complete';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const req = (body: unknown) => ({ method: 'POST', user: { id: 'u1' }, body, logger: { error: vi.fn() } }) as never;
const run = (body: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(body), res);

describe('POST /api/data-lakes/batches/upload-complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.setStatusIfActive.mockResolvedValue(null);
    h.incrementCounter.mockResolvedValue(null);
    h.update.mockResolvedValue(null);
    h.finalizeBatchIfComplete.mockResolvedValue(undefined);
  });

  it('404s when the batch belongs to another user (no writes)', async () => {
    h.findById.mockResolvedValue({ id: 'b1', userId: 'someone-else' });
    const { res } = makeRes();
    await run({ batchId: 'b1', failedFiles: 2 }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(h.incrementCounter).not.toHaveBeenCalled();
    expect(h.setStatusIfActive).not.toHaveBeenCalled();
    expect(h.finalizeBatchIfComplete).not.toHaveBeenCalled();
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
    expect(json).toHaveBeenCalledWith({ success: true });
  });

  it('with zero browser failures: skips the increment but still moves to processing + finalizes', async () => {
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', totalFiles: 3 });
    const { res } = makeRes();
    await run({ batchId: 'b1', failedFiles: 0 }, res);

    expect(h.incrementCounter).not.toHaveBeenCalled();
    expect(h.setStatusIfActive).toHaveBeenCalledWith('b1', 'processing');
    expect(h.finalizeBatchIfComplete).toHaveBeenCalledTimes(1);
  });
});
