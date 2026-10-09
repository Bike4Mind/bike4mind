import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  // Order log: 'enter'/'exit' bracket the transaction, other entries are pushed by the stubs inside it.
  tx: [] as string[],
  touchIfStable: vi.fn(),
  dismissTaxonomySuggestion: vi.fn(),
  toAccessContext: vi.fn(),
  batchFindById: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method (same shape as apply-taxonomy.test.ts).
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
  withTransaction: async (fn: () => unknown) => {
    h.tx.push('enter');
    try {
      return await fn();
    } finally {
      h.tx.push('exit');
    }
  },
  dataLakeRepository: { touchIfStable: h.touchIfStable },
  dataLakeBatchRepository: { findById: h.batchFindById },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { dismissTaxonomySuggestion: h.dismissTaxonomySuggestion },
}));
// Real toAccessContext pulls in entitlements/subscription lookups that are out of scope here;
// stub it to the caller identity, same shape the route previously built inline.
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../dismiss-taxonomy';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const req = (batchId: string, user: { id: string; isAdmin: boolean } = { id: 'u1', isAdmin: false }) =>
  ({ method: 'POST', user, query: { batchId }, body: {}, logger: { error: vi.fn() } }) as never;
const run = (batchId: string, res: unknown, user?: { id: string; isAdmin: boolean }) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(batchId, user), res);

describe('POST /api/data-lakes/batches/[batchId]/dismiss-taxonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tx.length = 0;
    h.dismissTaxonomySuggestion.mockResolvedValue({ success: true });
    h.batchFindById.mockResolvedValue({ id: 'b1', dataLakeId: 'lake-1' });
    h.toAccessContext.mockImplementation((req: { user: { id: string; isAdmin: boolean } }) =>
      Promise.resolve({ userId: req.user.id, isAdmin: req.user.isAdmin })
    );
  });

  it('delegates to the service with the caller identity and batchId, and returns its result', async () => {
    const { res, json } = makeRes();
    await run('b1', res, { id: 'admin1', isAdmin: true });

    expect(h.dismissTaxonomySuggestion).toHaveBeenCalledWith(
      { userId: 'admin1', isAdmin: true },
      'b1',
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ success: true });
  });

  it("runs the service inside the transaction, then touches the batch's lake last", async () => {
    h.dismissTaxonomySuggestion.mockImplementation(async () => {
      h.tx.push('service');
      return { success: true };
    });
    h.touchIfStable.mockImplementation(async () => {
      h.tx.push('touch');
      return true;
    });
    const { res } = makeRes();
    await run('b1', res);

    expect(h.tx).toEqual(['enter', 'service', 'touch', 'exit']);
    expect(h.touchIfStable).toHaveBeenCalledWith('lake-1');
  });

  it('touches nothing when the service refuses', async () => {
    h.dismissTaxonomySuggestion.mockRejectedValue(new Error('no permission'));
    const { res } = makeRes();

    await expect(run('b1', res)).rejects.toThrow(/no permission/);
    expect(h.touchIfStable).not.toHaveBeenCalled();
  });
});
