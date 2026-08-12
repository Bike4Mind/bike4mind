import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  archiveDataLake: vi.fn(),
  deleteDataLake: vi.fn(),
  cleanupDeletedDataLake: vi.fn(),
  // Real admin-or-creator logic (not a bare stub) so the cleanup action's canManageLake call
  // behaves identically to production for these tests, including the blank-identity case.
  canManageLake: vi.fn(
    (lake: { createdByUserId?: string }, actor: { userId?: string; isAdmin: boolean }) =>
      actor.isAdmin || (!!actor.userId && !!lake.createdByUserId && lake.createdByUserId === actor.userId)
  ),
  openSearchRetrievalIndex: vi.fn(() => ({ removeForDataLake: vi.fn() })),
  sendToQueue: vi.fn(),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/data-lake-cleanup'),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  selfHostOpenSearchEnabled: vi.fn(() => false),
}));

// baseApi mock: callable chain routed by req.method (same shape as the serve/gears tests).
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
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    archiveDataLake: h.archiveDataLake,
    deleteDataLake: h.deleteDataLake,
    cleanupDeletedDataLake: h.cleanupDeletedDataLake,
    canManageLake: h.canManageLake,
    openSearchRetrievalIndex: h.openSearchRetrievalIndex,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeBatchRepository: {},
  fabFileRepository: {},
  fabFileChunkRepository: {},
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));

import handler from '../lifecycle';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json, statusJson: json };
};
const req = (body: unknown) => ({ method: 'POST', query: { id: 'lake1' }, body }) as never;

describe('POST /api/data-lakes/[id]/lifecycle - cleanup action (enqueue offload)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeWritable.mockReturnValue(undefined);
    h.sendToQueue.mockResolvedValue(undefined);
  });

  it('enqueues the cleanup and returns 202 for the owner without running the sweep inline', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'u1' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/data-lake-cleanup', {
      dataLakeId: 'lake1',
      actor: { userId: 'u1', isAdmin: false },
    });
    expect(h.cleanupDeletedDataLake).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('rejects with 403 and does not enqueue when a non-owner requests cleanup', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: 'someone-else' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects with 400 and does not enqueue when the lake is not soft-deleted', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'active', createdByUserId: 'u1' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('now delegates to canManageLake, so a blank-identity lake is rejected rather than granted (#1153)', async () => {
    h.toAccessContext.mockResolvedValueOnce({ userId: '', isAdmin: false });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted', createdByUserId: undefined });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(h.canManageLake).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

// Only self-host OpenSearch needs this port wired (see ports.ts) - Atlas's index lives on the
// FabFileChunk collection itself, so it needs no separate removal.
describe('POST /api/data-lakes/[id]/lifecycle - retrievalIndex wiring (archive/delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeWritable.mockReturnValue(undefined);
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'active', createdByUserId: 'u1' });
    h.archiveDataLake.mockResolvedValue({ id: 'lake1', status: 'archived' });
    h.deleteDataLake.mockResolvedValue({ id: 'lake1', status: 'deleted' });
  });

  it('archive passes retrievalIndex: undefined when self-host OpenSearch is off', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'archive' }), res);

    expect(h.openSearchRetrievalIndex).not.toHaveBeenCalled();
    expect(h.archiveDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: undefined })
    );
  });

  it('archive wires a real retrievalIndex when self-host OpenSearch is on', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'archive' }), res);

    expect(h.openSearchRetrievalIndex).toHaveBeenCalled();
    expect(h.archiveDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: expect.objectContaining({ removeForDataLake: expect.anything() }) })
    );
  });

  it('delete passes retrievalIndex: undefined when self-host OpenSearch is off', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'delete' }), res);

    expect(h.openSearchRetrievalIndex).not.toHaveBeenCalled();
    expect(h.deleteDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: undefined })
    );
  });

  it('delete wires a real retrievalIndex when self-host OpenSearch is on', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'delete' }), res);

    expect(h.openSearchRetrievalIndex).toHaveBeenCalled();
    expect(h.deleteDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ retrievalIndex: expect.objectContaining({ removeForDataLake: expect.anything() }) })
    );
  });
});
