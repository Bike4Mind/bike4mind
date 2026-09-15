import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  applyTaxonomySuggestions: vi.fn(),
  toAccessContext: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method (same shape as upload-complete.test.ts).
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
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { applyTaxonomySuggestions: h.applyTaxonomySuggestions },
}));
// Real toAccessContext pulls in entitlements/subscription lookups that are out of scope here;
// stub it to the caller identity, same shape the route previously built inline.
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../apply-taxonomy';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};
const req = (batchId: string, body: unknown, user: { id: string; isAdmin: boolean } = { id: 'u1', isAdmin: false }) =>
  ({ method: 'POST', user, query: { batchId }, body, logger: { error: vi.fn() } }) as never;
const run = (batchId: string, body: unknown, res: unknown, user?: { id: string; isAdmin: boolean }) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(batchId, body, user), res);

describe('POST /api/data-lakes/batches/[batchId]/apply-taxonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Carries all four fields: the route is the only hop where nothing else pins that `unchanged`
    // and `skipped` reach the client, and the toast arms downstream are built on both.
    h.applyTaxonomySuggestions.mockResolvedValue({ success: true, filesUpdated: 3, unchanged: 1, skipped: 2 });
    h.toAccessContext.mockImplementation((req: { user: { id: string; isAdmin: boolean } }) =>
      Promise.resolve({ userId: req.user.id, isAdmin: req.user.isAdmin })
    );
  });

  it('filters out deleted tags before delegating to the service', async () => {
    const { res, json } = makeRes();
    const tags = [
      {
        suffix: 'type:contract',
        originalName: 'acme:type:contract',
        strength: 0.9,
        source: 'ai',
        matchingFolders: [],
        deleted: false,
      },
      {
        suffix: 'topic:hr',
        originalName: 'acme:topic:hr',
        strength: 0.8,
        source: 'ai',
        matchingFolders: [],
        deleted: true,
      },
    ];
    await run('b1', { tags }, res);

    expect(h.applyTaxonomySuggestions).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'b1',
      [tags[0]],
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ success: true, filesUpdated: 3, unchanged: 1, skipped: 2 });
  });

  it('passes the caller identity through for the service to authorize', async () => {
    const { res } = makeRes();
    await run('b1', { tags: [] }, res, { id: 'admin1', isAdmin: true });

    expect(h.applyTaxonomySuggestions).toHaveBeenCalledWith(
      { userId: 'admin1', isAdmin: true },
      'b1',
      [],
      expect.anything()
    );
  });
});
