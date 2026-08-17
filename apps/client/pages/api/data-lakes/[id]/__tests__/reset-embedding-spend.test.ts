import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resetEmbeddingSpend: vi.fn(),
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
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { resetEmbeddingSpend: h.resetEmbeddingSpend },
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
    logger: { log: vi.fn() },
  }) as never;

beforeEach(() => vi.clearAllMocks());

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
    h.resetEmbeddingSpend.mockResolvedValue(false);
    await expect(
      (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(true), makeRes())
    ).rejects.toThrow(/not found/);
  });
});
