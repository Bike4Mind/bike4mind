import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  updateIfActive: vi.fn(),
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
  // The config-audit repos the code under test now wires (see lakeConfigAuditDb). Stubbed
  // rather than omitted because this mock REPLACES the whole module: a missing export is an
  // import-time failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeBatchRepository: {
    findById: h.findById,
    updateIfActive: h.updateIfActive,
    markTerminalIfActive: h.markTerminalIfActive,
  },
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

describe('/api/data-lakes/batches/[batchId] lake stats on a terminal batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', dataLakeId: 'lake1', status: 'uploading' });
    // The guarded write WINS by default: it returns the post-update doc to the single caller that
    // moved a still-non-terminal batch, and null to one whose batch was already settled.
    h.updateIfActive.mockResolvedValue({ id: 'b1', status: 'failed' });
    h.markTerminalIfActive.mockResolvedValue({ id: 'b1', status: 'cancelled' });
    h.lakeFindById.mockResolvedValue({ id: 'lake1', datalakeTag: 'datalake:lake', fileTagPrefix: 'lake:' });
    h.recomputeLakeStats.mockResolvedValue({ fileCount: 2, totalSizeBytes: 20 });
  });

  it('recomputes the lake when the client fails a batch that had already uploaded files', async () => {
    // Nothing else counts these files: the finalizer never runs for a failed batch and the
    // stuck-batch reconciler skips terminal ones, so without this the lake stays empty and draft.
    const { res } = makeRes();

    await run('PUT', res, { status: 'failed', failedFiles: 1 });

    // Asserts the audit adapters BY NAME, not expect.anything(): both reach recomputeLakeStats
    // through one shared `db` literal, and `adminSettings` is optional, so a route that dropped
    // either would still compile and silently write no event (or pin every event to the floor
    // retention) with nothing else going red.
    expect(h.recomputeLakeStats).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake1' }),
      expect.objectContaining({
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.anything(),
          adminSettings: expect.anything(),
        }),
      }),
      // The actor: this route is authenticated, so its auto-activate must not record as `system`.
      expect.objectContaining({ actor: expect.objectContaining({ userId: 'u1' }) })
    );
  });

  it('recomputes the lake on a cancel', async () => {
    const { res } = makeRes();

    await run('DELETE', res);

    // Asserts the audit adapters BY NAME, not expect.anything(): both reach recomputeLakeStats
    // through one shared `db` literal, and `adminSettings` is optional, so a route that dropped
    // either would still compile and silently write no event (or pin every event to the floor
    // retention) with nothing else going red.
    expect(h.recomputeLakeStats).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake1' }),
      expect.objectContaining({
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.anything(),
          adminSettings: expect.anything(),
        }),
      }),
      // The actor: this route is authenticated, so its auto-activate must not record as `system`.
      expect.objectContaining({ actor: expect.objectContaining({ userId: 'u1' }) })
    );
  });

  it('does not recompute a terminal status the batch already holds', async () => {
    // A client re-PUTting 'failed' would otherwise run a whole-lake aggregation per call. The guard
    // is what reports this now: an already-terminal batch loses the claim, so updateIfActive is null.
    h.findById.mockResolvedValue({ id: 'b1', userId: 'u1', dataLakeId: 'lake1', status: 'failed' });
    h.updateIfActive.mockResolvedValue(null);
    const { res } = makeRes();

    await run('PUT', res, { status: 'failed' });

    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
  });

  it('routes the status write through the guard, so a settled batch is never resurrected (#2089)', async () => {
    // The window without a client in sight: the status guard used to be read from `findById` above
    // while the write was a plain $set, so a queue finalization landing in between was BOTH
    // overwritten (the batch went back to non-terminal, reappeared in findActiveByUserId, and
    // reconcileStuckBatches later force-failed a batch that had succeeded) AND mis-classified here,
    // firing a second whole-lake aggregation.
    h.updateIfActive.mockResolvedValue(null);
    const { res, json } = makeRes();

    await run('PUT', res, { status: 'uploading' });

    // The guarded method is the only write path - a plain `update` would bypass the guard entirely.
    expect(h.updateIfActive).toHaveBeenCalledWith('b1', expect.objectContaining({ status: 'uploading' }));
    // Losing is a benign no-op, not a 500: the batch is already settled so the intent is moot.
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
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
