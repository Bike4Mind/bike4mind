import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resetEmbeddingSpend: vi.fn(),
  findById: vi.fn(),
  deleteForLake: vi.fn(async () => 0),
  recordAdminAction: vi.fn(),
  inTransaction: false,
  insideTransactionAtAudit: undefined as boolean | undefined,
}));

// baseApi mock: callable chain routed by req.method (same shape as the lifecycle tests).
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
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { resetEmbeddingSpend: h.resetEmbeddingSpend, findById: h.findById },
  dataLakeSpendNotificationRepository: { deleteForLake: h.deleteForLake },
  withTransaction: async (fn: () => Promise<unknown>) => {
    h.inTransaction = true;
    try {
      return await fn();
    } finally {
      h.inTransaction = false;
    }
  },
}));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => {
    h.insideTransactionAtAudit = h.inTransaction;
    return h.recordAdminAction(...args);
  },
}));

import handler from '../reset-embedding-spend';

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const makeReq = (isAdmin: boolean) =>
  ({
    method: 'POST',
    query: { id: 'lake-1' },
    user: { id: 'admin-1', isAdmin },
    logger: { log: vi.fn(), warn: vi.fn() },
  }) as never;

const LAKE = {
  id: 'lake-1',
  name: 'Research',
  organizationId: 'org-1',
  createdByUserId: 'owner-1',
  embeddingSpendMicroUsd: 4200,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue(LAKE);
  h.recordAdminAction.mockResolvedValue(null);
  h.insideTransactionAtAudit = undefined;
});

describe('POST /api/data-lakes/[id]/reset-embedding-spend', () => {
  it('resets the meter for an admin', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    const res = makeRes();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(true), res);

    expect(h.resetEmbeddingSpend).toHaveBeenCalledWith('lake-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('refuses a non-admin before touching the meter', async () => {
    const res = makeRes();
    await expect(
      (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(false), res)
    ).rejects.toThrow(/Admin access required/);
    expect(h.resetEmbeddingSpend).not.toHaveBeenCalled();
  });

  it('404s on an unknown lake', async () => {
    h.findById.mockResolvedValue(null);
    await expect(
      (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(true), makeRes())
    ).rejects.toThrow(/not found/);
    expect(h.deleteForLake).not.toHaveBeenCalled();
  });

  it('re-arms the lake-scope spend notice after a successful reset', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    const res = makeRes();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(true), res);

    // Scoped to 'lake' only - a period/run/switch notice for the same lake must survive a reset.
    expect(h.deleteForLake).toHaveBeenCalledWith('lake-1', 'lake');
  });

  it('a re-arm failure is logged, never fails the reset request', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    h.deleteForLake.mockRejectedValueOnce(new Error('mongo down'));
    const res = makeRes();

    await expect(
      (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(true), res)
    ).resolves.toBeUndefined();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('records org.data_lake.embedding_spend_reset with the zeroed meter inside the transaction', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(true), makeRes());

    expect(h.insideTransactionAtAudit).toBe(true);
    expect(h.recordAdminAction).toHaveBeenCalledTimes(1);
    expect(h.recordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.data_lake.embedding_spend_reset',
        target: expect.objectContaining({ kind: 'settings', id: 'lake-1' }),
        organizationId: 'org-1',
        changes: [{ field: 'embeddingSpendMicroUsd', before: 4200, after: 0 }],
      })
    );
  });

  it('fails the request and skips the re-arm when the audit write fails', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    h.recordAdminAction.mockRejectedValueOnce(new Error('audit down'));
    const res = makeRes();

    await expect(
      (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(true), res)
    ).rejects.toThrow('audit down');
    expect(res.status).not.toHaveBeenCalled();
    expect(h.deleteForLake).not.toHaveBeenCalled();
  });
});
