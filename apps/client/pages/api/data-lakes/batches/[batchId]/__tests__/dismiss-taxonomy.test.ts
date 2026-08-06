import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  dismissTaxonomySuggestion: vi.fn(),
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
  dataLakeRepository: {},
  dataLakeBatchRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { dismissTaxonomySuggestion: h.dismissTaxonomySuggestion },
}));

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
    h.dismissTaxonomySuggestion.mockResolvedValue({ success: true });
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
});
