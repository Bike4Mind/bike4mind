import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  cleanupDeletedDataLake: vi.fn(),
  sendToQueue: vi.fn(),
  getSourceQueueUrl: vi.fn(() => 'https://sqs.example.com/data-lake-cleanup'),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
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
    cleanupDeletedDataLake: h.cleanupDeletedDataLake,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeBatchRepository: {},
  fabFileRepository: {},
}));
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

  it('enqueues the cleanup and returns 202 without running the sweep inline', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'deleted' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example.com/data-lake-cleanup', {
      dataLakeId: 'lake1',
      actor: { userId: 'u1', isAdmin: false },
    });
    expect(h.cleanupDeletedDataLake).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('rejects with 400 and does not enqueue when the lake is not soft-deleted', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', status: 'active' });
    const { res } = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req({ action: 'cleanup' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});
