import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWriteAccess: vi.fn(),
  detectUnderChunkedFiles: vi.fn(),
  resetChunkStateByIds: vi.fn(),
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
    DEFAULT_REBUILD_WAVE: 50,
    MAX_REBUILD_WAVE: 200,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  fabFileRepository: { resetChunkStateByIds: h.resetChunkStateByIds },
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

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(lake);
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.resetChunkStateByIds.mockResolvedValue(0);
  h.sendToQueue.mockResolvedValue(undefined);
});

describe('GET /api/data-lakes/[id]/rechunk', () => {
  it('returns the under-chunked count (read access, no writes)', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'f2', userId: 'u1' },
    ]);
    const { json } = await invoke('GET');
    expect(json).toHaveBeenCalledWith({ underChunkedCount: 2 });
    expect(h.assertLakeAccess).toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/[id]/rechunk', () => {
  it('resets and enqueues the whole detected set when under the wave cap', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'f2', userId: 'u2' },
    ]);
    const { json } = await invoke('POST', {});
    expect(h.assertLakeWriteAccess).toHaveBeenCalled();
    expect(h.resetChunkStateByIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'f1',
      userId: 'u1',
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/fab-file-chunk', {
      fabFileId: 'f2',
      userId: 'u2',
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

  it('is a no-op enqueue when nothing is under-chunked', async () => {
    h.detectUnderChunkedFiles.mockResolvedValue([]);
    const { json } = await invoke('POST', {});
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ detected: 0, enqueued: 0, remaining: 0 });
  });

  it('gates on write access - a rejected assert never enqueues', async () => {
    h.assertLakeWriteAccess.mockRejectedValue(new Error('Only the creator can add files to this data lake'));
    await expect(invoke('POST', {})).rejects.toThrow(/creator/);
    expect(h.detectUnderChunkedFiles).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});
