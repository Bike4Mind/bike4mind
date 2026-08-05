import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  markTerminalIfActive: vi.fn(),
  lakeFindById: vi.fn(),
  recomputeLakeStats: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method (same shape as upload-complete.test.ts).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { findById: h.findById, update: h.update, markTerminalIfActive: h.markTerminalIfActive },
  dataLakeRepository: { findById: h.lakeFindById },
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { recomputeLakeStats: h.recomputeLakeStats } }));

import handler from '../[batchId]';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const req = (method: string, body: unknown = {}) =>
  ({ method, user: { id: 'u1' }, query: { batchId: 'b1' }, body, logger: { error: vi.fn() } }) as never;
const run = (method: string, res: unknown, body?: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(method, body), res);

describe('/api/data-lakes/batches/[batchId] — lake stats on a terminal batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', dataLakeId: 'lake1', status: 'uploading' });
    h.update.mockResolvedValue(null);
    h.markTerminalIfActive.mockResolvedValue({ id: 'b1', status: 'cancelled' });
    h.lakeFindById.mockResolvedValue({ id: 'lake1', datalakeTag: 'datalake:lake', fileTagPrefix: 'lake:' });
    h.recomputeLakeStats.mockResolvedValue({ fileCount: 2, totalSizeBytes: 20 });
  });

  it('recomputes the lake when the client fails a batch that had already uploaded files', async () => {
    // Nothing else counts these files: the finalizer never runs for a failed batch and the
    // stuck-batch reconciler skips terminal ones, so without this the lake stays empty and draft.
    const { res } = makeRes();

    await run('PUT', res, { status: 'failed', failedFiles: 1 });

    expect(h.recomputeLakeStats).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake1' }), expect.anything());
  });

  it('recomputes the lake on a cancel', async () => {
    const { res } = makeRes();

    await run('DELETE', res);

    expect(h.recomputeLakeStats).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake1' }), expect.anything());
  });

  it('does not recompute while the batch is still running', async () => {
    const { res } = makeRes();

    await run('PUT', res, { status: 'uploading' });

    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
  });

  it('does not recompute a cancel the guard refused', async () => {
    h.markTerminalIfActive.mockResolvedValue(null);
    const { res, json } = makeRes();

    await run('DELETE', res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/already/i) }));
    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
  });

  it('still answers success when the recompute throws', async () => {
    // The batch transition is already committed - a stats failure must not turn it into a 500.
    h.recomputeLakeStats.mockRejectedValue(new Error('mongo down'));
    const { res, json } = makeRes();

    await run('DELETE', res);

    expect(json).toHaveBeenCalledWith({ success: true });
  });
});
