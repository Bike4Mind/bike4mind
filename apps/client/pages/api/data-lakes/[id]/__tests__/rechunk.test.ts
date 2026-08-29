import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeRebuildAccess: vi.fn(),
  detectUnderChunkedFiles: vi.fn(),
  countFailedLakeFiles: vi.fn(),
  resetChunkStateByIds: vi.fn(),
  sendToQueue: vi.fn(),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/fab-file-chunk'),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  isConvergenceHalted: vi.fn(async () => false),
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
    detectUnderChunkedFiles: h.detectUnderChunkedFiles,
    countFailedLakeFiles: h.countFailedLakeFiles,
    DEFAULT_REBUILD_WAVE: 50,
    MAX_REBUILD_WAVE: 200,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {
    resetChunkStateByIds: h.resetChunkStateByIds,
  },
  fabFileChunkRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));
vi.mock('@server/queueHandlers/convergenceProvenance', () => ({ CONVERGENCE_ORIGIN: 'convergence' }));
vi.mock('@server/queueHandlers/convergenceKillSwitch', () => ({ isConvergenceHalted: h.isConvergenceHalted }));

import handler from '../rechunk';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const invoke = async (method: 'GET' | 'POST', body: unknown = {}) => {
  const { res, json } = makeRes();
  await (handler as (req: unknown, res: unknown) => Promise<void>)(
    { method, query: { id: 'lake1' }, body } as never,
    res
  );
  return { res, json };
};

const lake = { id: 'lake1', datalakeTag: 'datalake:acme', createdByUserId: 'u1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(lake);
  h.assertLakeRebuildAccess.mockResolvedValue(lake);
  h.countFailedLakeFiles.mockResolvedValue(0);
  // By default the claim wins every id it's asked for, each with a claim stamp (the token the
  // message carries so the worker can reject a superseded/duplicate delivery).
  // Returns the ids actually reset - a file a worker is mid-run on is skipped (round-8 P1).
  h.resetChunkStateByIds.mockImplementation(async (ids: string[]) => ids);
  h.sendToQueue.mockResolvedValue(undefined);
  // Switch OFF by default; the paused cases below opt in.
  h.isConvergenceHalted.mockResolvedValue(false);
});

describe('GET /api/data-lakes/[id]/rechunk', () => {
  it('returns the under-chunked count and the failed count (read access, no writes)', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'f2', userId: 'u1' },
    ]);
    h.countFailedLakeFiles.mockResolvedValue(1);
    const { json } = await invoke('GET');
    expect(json).toHaveBeenCalledWith({ underChunkedCount: 2, failedCount: 1 });
    expect(h.assertLakeAccess).toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/[id]/rechunk', () => {
  it('enqueues only the files the reset actually won, and folds the skipped ones back into remaining', async () => {
    // A file a worker is mid-run on is skipped by the reset's precondition, so resetIds is a proper
    // subset of the wave. Every other test here mocks the reset as identity, which makes skipped
    // always 0 and leaves this accounting - the reason the reset returns ids at all - unexercised.
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'busy', userId: 'u2' },
    ]);
    h.resetChunkStateByIds.mockResolvedValue(['f1']);

    const { json } = await invoke('POST', {});

    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'f1',
      userId: 'u1',
      origin: 'convergence',
      lakeId: 'lake1',
    });
    // The skipped file is not enqueued and is still outstanding, so it must remain countable.
    expect(json).toHaveBeenCalledWith({ detected: 2, enqueued: 1, remaining: 1 });
  });

  it('resets and enqueues the whole detected set when under the wave cap', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'f2', userId: 'u2' },
    ]);
    const { json } = await invoke('POST', {});
    expect(h.assertLakeRebuildAccess).toHaveBeenCalled();
    expect(h.resetChunkStateByIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'f1',
      userId: 'u1',
      origin: 'convergence',
      lakeId: 'lake1',
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'f2',
      userId: 'u2',
      origin: 'convergence',
      lakeId: 'lake1',
    });
    expect(json).toHaveBeenCalledWith({ detected: 2, enqueued: 2, remaining: 0 });
  });

  it('caps the wave at `limit` (worst-first) and reports the remainder', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'a', userId: 'u' },
      { fabFileId: 'b', userId: 'u' },
      { fabFileId: 'c', userId: 'u' },
    ]);
    const { json } = await invoke('POST', { limit: 2 });
    expect(h.resetChunkStateByIds).toHaveBeenCalledWith(['a', 'b']);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenCalledWith({ detected: 3, enqueued: 2, remaining: 1 });
  });

  it('leaves a file whose send failed in the reset state, and excludes it from `enqueued`', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'ok', userId: 'u1' },
      { fabFileId: 'bad', userId: 'u2' },
    ]);
    // first send lands, second rejects (SQS hiccup)
    h.sendToQueue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('sqs unavailable'));
    const { json } = await invoke('POST', {});
    expect(h.resetChunkStateByIds).toHaveBeenCalledWith(['ok', 'bad']);
    expect(json).toHaveBeenCalledWith({ detected: 2, enqueued: 1, remaining: 1 });
  });

  it('resets the whole wave in ONE call, then enqueues each id', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'a', userId: 'u' },
      { fabFileId: 'b', userId: 'u' },
    ]);
    const { json } = await invoke('POST', {});
    // One bulk reset for the wave - no per-file claim, because mutual exclusion is the chunk
    // worker's compare-and-set, not a producer-side reservation.
    expect(h.resetChunkStateByIds).toHaveBeenCalledTimes(1);
    expect(h.resetChunkStateByIds).toHaveBeenCalledWith(['a', 'b']);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenCalledWith({ detected: 2, enqueued: 2, remaining: 0 });
  });

  it('is a no-op enqueue when nothing is under-chunked', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([]);
    const { json } = await invoke('POST', {});
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ detected: 0, enqueued: 0, remaining: 0 });
  });

  it('refuses BEFORE the reset when the convergence kill switch is on (#2223)', async () => {
    // The producer-side gate is the whole point: the consumer's check only drops messages already
    // on the queue, and by then resetChunkStateByIds has deleted this wave's passages and nulled its
    // health rollups. A consumer-side stamp cannot protect a route that destroys before it enqueues.
    h.isConvergenceHalted.mockResolvedValue(true);
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'f2', userId: 'u1' },
    ]);
    const { json } = await invoke('POST', {});

    // Nothing touched - this is what "before the reset" means.
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    // And the caller is told, rather than shown a silent zero-count success.
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'paused', enqueued: 0, detected: 2, remaining: 2 })
    );
  });

  it('asks the kill switch about THIS lake, so a per-lake override is honoured', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([{ fabFileId: 'f1', userId: 'u1' }]);
    await invoke('POST', {});

    // First argument only: the third is req.logger, which this harness's fake request does not carry.
    expect(h.isConvergenceHalted.mock.calls[0][0]).toEqual({ origin: 'convergence', lakeId: 'lake1' });
  });

  it('stamps convergence provenance on every message, so an in-flight wave halts too', async () => {
    // The producer gate protects the passages; the stamp is what stops the consumer continuing to
    // re-embed if the switch is turned on after these messages were already sent.
    h.detectUnderChunkedFiles.mockResolvedValue([{ fabFileId: 'f1', userId: 'u1' }]);
    await invoke('POST', {});

    expect(h.sendToQueue).toHaveBeenCalledWith(
      'https://sqs.example.com/fab-file-chunk',
      expect.objectContaining({ fabFileId: 'f1', userId: 'u1', origin: 'convergence', lakeId: 'lake1' })
    );
  });

  it('does not consult the kill switch when there is nothing to rechunk', async () => {
    // The gate sits inside the wave.length > 0 branch, so an empty detection costs no settings read.
    h.detectUnderChunkedFiles.mockResolvedValue([]);
    await invoke('POST', {});

    expect(h.isConvergenceHalted).not.toHaveBeenCalled();
  });

  it('gates on rebuild access - a rejected assert never resets or enqueues', async () => {
    h.assertLakeRebuildAccess.mockRejectedValue(
      new Error("You do not have permission to rebuild this data lake's passages")
    );
    await expect(invoke('POST', {})).rejects.toThrow(/permission to rebuild/);
    expect(h.detectUnderChunkedFiles).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});
