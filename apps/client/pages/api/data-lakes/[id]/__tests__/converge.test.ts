import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeRebuildAccess: vi.fn(),
  planLakeConvergenceRun: vi.fn(),
  resetChunkStateByIds: vi.fn(),
  sendToQueue: vi.fn(),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/fab-file-chunk'),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  getSettingsValue: vi.fn(async () => 'text-embedding-3-small'),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeRebuildAccess: h.assertLakeRebuildAccess,
    planLakeConvergenceRun: h.planLakeConvergenceRun,
    DEFAULT_CONVERGENCE_WAVE: 25,
    MAX_CONVERGENCE_WAVE: 200,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: { resetChunkStateByIds: h.resetChunkStateByIds },
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  scopedSettingsRepository: {},
}));
vi.mock('@bike4mind/common', () => ({ isSupportedEmbeddingModel: () => true }));
vi.mock('@bike4mind/utils', () => ({ BadRequestError: class BadRequestError extends Error {} }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));

import handler from '../converge';

const lake = { id: 'lake1', datalakeTag: 'datalake:acme', createdByUserId: 'u1' };

const report = (over: Record<string, unknown> = {}) => ({
  refusal: null,
  policy: { requiredTarget: 512, effectiveRequiredTarget: 512, policyChars: 3072 },
  membersConsidered: 40,
  convergeableCount: 2,
  waveSize: 2,
  changeShare: 0.05,
  requiresConfirmation: false,
  bulkChangeShareThreshold: 0.25,
  skipped: { conformant: 38, unmeasured: 0, indexingInFlight: 0, previouslyFailed: 0 },
  crossLakeConflicts: [],
  crossLakeConflictCount: 0,
  scanTruncated: false,
  ...over,
});

const invoke = async (method: 'GET' | 'POST', body: unknown = {}) => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(
    { method, query: { id: 'lake1' }, body, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never,
    res
  );
  return json;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(lake);
  h.assertLakeRebuildAccess.mockResolvedValue(lake);
  h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
  h.planLakeConvergenceRun.mockResolvedValue({
    report: report(),
    wave: [
      { fabFileId: 'f1', userId: 'u1', overshootChars: 900 },
      { fabFileId: 'f2', userId: 'u2', overshootChars: 100 },
    ],
  });
  h.resetChunkStateByIds.mockResolvedValue(['f1', 'f2']);
  h.sendToQueue.mockResolvedValue(undefined);
});

describe('GET /api/data-lakes/:id/converge', () => {
  // The plan is a preview and writes nothing, so it uses the READ gate - the same reasoning that
  // makes lake health reader-visible. Only executing needs manage.
  it('gates on read access and returns the plan without enqueuing anything', async () => {
    const json = await invoke('GET');

    expect(h.assertLakeAccess).toHaveBeenCalled();
    expect(h.assertLakeRebuildAccess).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ convergeableCount: 2 }));
  });
});

describe('POST /api/data-lakes/:id/converge', () => {
  it('gates on rebuild access', async () => {
    await invoke('POST');
    expect(h.assertLakeRebuildAccess).toHaveBeenCalled();
  });

  // The whole point of the feature: re-enqueuing WITHOUT a chunkSize would let the handler
  // re-resolve the file owner's DefaultChunkSize - the value that produced the non-conformant
  // chunks - and the re-chunk would deterministically reproduce them. Convergence must pin the
  // lake's own target.
  it("enqueues at the LAKE's required target, not the file owner's default", async () => {
    await invoke('POST');

    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(h.sendToQueue).toHaveBeenCalledWith(
      'https://sqs.example.com/fab-file-chunk',
      expect.objectContaining({ fabFileId: 'f1', userId: 'u1', chunkSize: 512 })
    );
  });

  // Without this the #1676 kill switch cannot halt a wave already on the queue - the messages would
  // be indistinguishable from a customer upload, which the switch must never stop.
  it('stamps convergence provenance so the kill switch can halt the wave', async () => {
    await invoke('POST');

    expect(h.sendToQueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ origin: 'convergence', lakeId: 'lake1' })
    );
  });

  it('enqueues only what the reset actually changed', async () => {
    // f2 raced to isChunking:true, so the reset skipped it; enqueuing it anyway would send a
    // message a worker will simply drop, and would overstate the reported count.
    h.resetChunkStateByIds.mockResolvedValue(['f1']);

    const json = await invoke('POST');

    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ enqueued: 1, outcome: 'enqueued' }));
  });

  it('does not fail the whole wave when one send fails', async () => {
    h.sendToQueue.mockRejectedValueOnce(new Error('sqs down'));

    const json = await invoke('POST');

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ enqueued: 1 }));
  });

  it('refuses an inherited-policy lake and enqueues nothing', async () => {
    h.planLakeConvergenceRun.mockResolvedValue({ report: report({ refusal: 'policyInherited' }), wave: [] });

    const json = await invoke('POST');

    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'policyInherited', enqueued: 0 }));
  });

  it('refuses a bulk change until it is confirmed', async () => {
    h.planLakeConvergenceRun.mockResolvedValue({
      report: report({ requiresConfirmation: true, changeShare: 0.9, convergeableCount: 36 }),
      wave: [{ fabFileId: 'f1', userId: 'u1', overshootChars: 900 }],
    });

    const json = await invoke('POST');

    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'confirmationRequired', enqueued: 0 }));
  });

  it('runs the same bulk change once confirmed', async () => {
    h.planLakeConvergenceRun.mockResolvedValue({
      report: report({ requiresConfirmation: true, changeShare: 0.9, convergeableCount: 36 }),
      wave: [{ fabFileId: 'f1', userId: 'u1', overshootChars: 900 }],
    });
    h.resetChunkStateByIds.mockResolvedValue(['f1']);

    const json = await invoke('POST', { confirm: true });

    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'enqueued', enqueued: 1 }));
  });

  // `confirm` must not be a way past the LAKE-level refusal - that one is not an interlock a user
  // can acknowledge, it is a fact about the lake.
  it('does not let confirm bypass the inherited-policy refusal', async () => {
    h.planLakeConvergenceRun.mockResolvedValue({ report: report({ refusal: 'policyInherited' }), wave: [] });

    const json = await invoke('POST', { confirm: true });

    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'policyInherited' }));
  });

  // A run allowed to proceed but with nothing it CAN repair (everything left is cross-lake
  // conflicted) must not report as a successful enqueue - it returns here on every subsequent run,
  // and "enqueued 0" reads to a client as "already converged".
  it('reports a run with nothing repairable as noop, not enqueued', async () => {
    h.planLakeConvergenceRun.mockResolvedValue({
      report: report({ convergeableCount: 1, waveSize: 0, crossLakeConflictCount: 1 }),
      wave: [],
    });

    const json = await invoke('POST');

    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'noop', detected: 0, enqueued: 0 }));
  });

  it('honors an explicit wave limit', async () => {
    await invoke('POST', { limit: 5 });
    expect(h.planLakeConvergenceRun).toHaveBeenCalledWith(lake, expect.anything(), 5);
  });

  it('defaults the wave limit when none is sent', async () => {
    await invoke('POST');
    expect(h.planLakeConvergenceRun).toHaveBeenCalledWith(lake, expect.anything(), 25);
  });

  // A wrong embedding model silently mis-classifies every member, because the effective-target
  // comparison is model-dependent. Fail loudly rather than plan against it.
  it('refuses to plan when no supported embedding model is configured', async () => {
    h.getSettingsValue.mockResolvedValue(undefined);

    await expect(invoke('POST')).rejects.toThrow('Default embedding model not found');
    expect(h.planLakeConvergenceRun).not.toHaveBeenCalled();
  });
});
