import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWriteAccess: vi.fn(),
  detectUnderChunkedFiles: vi.fn(),
  countFailedLakeFiles: vi.fn(),
  claimFilesForRechunkByIds: vi.fn(),
  releaseChunkClaimByIds: vi.fn(),
  sendToQueue: vi.fn(),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/fab-file-chunk'),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
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
    assertLakeWriteAccess: h.assertLakeWriteAccess,
    detectUnderChunkedFiles: h.detectUnderChunkedFiles,
    countFailedLakeFiles: h.countFailedLakeFiles,
    DEFAULT_REBUILD_WAVE: 50,
    MAX_REBUILD_WAVE: 200,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  fabFileRepository: {
    claimFilesForRechunkByIds: h.claimFilesForRechunkByIds,
    releaseChunkClaimByIds: h.releaseChunkClaimByIds,
  },
  fabFileChunkRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));

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
const CLAIMED_AT = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(lake);
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.countFailedLakeFiles.mockResolvedValue(0);
  // By default the claim wins every id it's asked for, each with a claim stamp (the token the
  // message carries so the worker can reject a superseded/duplicate delivery).
  h.claimFilesForRechunkByIds.mockImplementation(async (ids: string[]) =>
    ids.map(id => ({ id, claimedAt: CLAIMED_AT }))
  );
  h.releaseChunkClaimByIds.mockResolvedValue(0);
  h.sendToQueue.mockResolvedValue(undefined);
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
    expect(h.claimFilesForRechunkByIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/[id]/rechunk', () => {
  it('claims and enqueues the whole detected set when under the wave cap', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'f2', userId: 'u2' },
    ]);
    const { json } = await invoke('POST', {});
    expect(h.assertLakeWriteAccess).toHaveBeenCalled();
    expect(h.claimFilesForRechunkByIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'f1',
      userId: 'u1',
      claimedAt: CLAIMED_AT,
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'f2',
      userId: 'u2',
      claimedAt: CLAIMED_AT,
    });
    expect(h.releaseChunkClaimByIds).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ detected: 2, enqueued: 2, remaining: 0 });
  });

  it('caps the wave at `limit` (worst-first) and reports the remainder', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'a', userId: 'u' },
      { fabFileId: 'b', userId: 'u' },
      { fabFileId: 'c', userId: 'u' },
    ]);
    const { json } = await invoke('POST', { limit: 2 });
    expect(h.claimFilesForRechunkByIds).toHaveBeenCalledWith(['a', 'b']);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenCalledWith({ detected: 3, enqueued: 2, remaining: 1 });
  });

  it('releases the claim on a file whose send failed, and excludes it from `enqueued`', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'ok', userId: 'u1' },
      { fabFileId: 'bad', userId: 'u2' },
    ]);
    // first send lands, second rejects (SQS hiccup)
    h.sendToQueue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('sqs unavailable'));
    const { json } = await invoke('POST', {});
    expect(h.claimFilesForRechunkByIds).toHaveBeenCalledWith(['ok', 'bad']);
    expect(h.releaseChunkClaimByIds).toHaveBeenCalledWith(['bad']); // un-strand the failed one
    expect(json).toHaveBeenCalledWith({ detected: 2, enqueued: 1, remaining: 1 });
  });

  it('enqueues only the ids the claim actually won (a concurrent wave took the rest)', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'a', userId: 'u' },
      { fabFileId: 'b', userId: 'u' },
      { fabFileId: 'c', userId: 'u' },
    ]);
    // 'b' was already claimed by a concurrent wave, so the claim returns only a and c.
    h.claimFilesForRechunkByIds.mockResolvedValue([
      { id: 'a', claimedAt: CLAIMED_AT },
      { id: 'c', claimedAt: CLAIMED_AT },
    ]);
    const { json } = await invoke('POST', {});
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'a',
      userId: 'u',
      claimedAt: CLAIMED_AT,
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'c',
      userId: 'u',
      claimedAt: CLAIMED_AT,
    });
    expect(h.sendToQueue).not.toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'b',
      userId: 'u',
      claimedAt: CLAIMED_AT,
    });
    expect(h.releaseChunkClaimByIds).not.toHaveBeenCalled();
    // enqueued counts what THIS call put on the queue; the lost id stays in `remaining`.
    expect(json).toHaveBeenCalledWith({ detected: 3, enqueued: 2, remaining: 1 });
  });

  it('is a no-op enqueue when nothing is under-chunked', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([]);
    const { json } = await invoke('POST', {});
    expect(h.claimFilesForRechunkByIds).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ detected: 0, enqueued: 0, remaining: 0 });
  });

  it('gates on write access - a rejected assert never claims or enqueues', async () => {
    h.assertLakeWriteAccess.mockRejectedValue(new Error('Only the creator can add files to this data lake'));
    await expect(invoke('POST', {})).rejects.toThrow(/creator/);
    expect(h.detectUnderChunkedFiles).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});
