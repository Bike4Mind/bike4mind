import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  resolveCanManageLake: vi.fn(),
  resolveSpendLevers: vi.fn(),
  lakeUsageSummary: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: [] })),
}));

// baseApi mock: callable chain routed by req.method (same shape as sibling endpoint tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    resolveCanManageLake: h.resolveCanManageLake,
    resolveSpendLevers: h.resolveSpendLevers,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  adminSettingsRepository: {},
  usageEventRepository: { lakeUsageSummary: h.lakeUsageSummary },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../spend';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (query: Record<string, string>) => ({ method: 'GET', query, logger: undefined }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

const emptyLedger = {
  overTime: [],
  byMember: [],
  byModel: [],
  byFeature: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
};

describe('GET /api/data-lakes/[id]/spend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', embeddingSpendMicroUsd: 5_000_000 });
    h.resolveCanManageLake.mockResolvedValue(true);
    h.resolveSpendLevers.mockResolvedValue({
      spendEnabled: true,
      perRunBudgetMicroUsd: 5_000_000,
      perLakeBudgetMicroUsd: 100_000_000,
      perPeriodBudgetMicroUsd: 50_000_000,
      periodHours: 24,
    });
    h.lakeUsageSummary.mockResolvedValue(emptyLedger);
  });

  it('returns the spend payload for an owner/curator', async () => {
    const { res, json } = makeRes();

    await call(req({ id: 'my-lake' }), res);

    // assertLakeAccess resolves id-or-slug, so the ledger query must use lake.id, not the raw query value.
    expect(h.lakeUsageSummary).toHaveBeenCalledWith('lake-oid-1', 30);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lake-oid-1',
        days: 30,
        embeddingSpendMicroUsd: 5_000_000,
        spendEnabled: true,
        ledger: emptyLedger,
      })
    );
  });

  it('403s a reader who can access but not manage the lake', async () => {
    h.resolveCanManageLake.mockResolvedValue(false);
    const { res } = makeRes();

    await expect(call(req({ id: 'lake1' }), res)).rejects.toThrow();
    expect(h.lakeUsageSummary).not.toHaveBeenCalled();
  });

  it('does not proceed when the access gate denies the lake (not-found style)', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req({ id: 'lake1' }), res)).rejects.toThrow(/not found/i);
    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
  });

  it('returns a zeroed (not error) summary for a lake with no ledgered spend', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-empty', embeddingSpendMicroUsd: undefined });
    const { res, json } = makeRes();

    await call(req({ id: 'lake-empty' }), res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ embeddingSpendMicroUsd: null, ledger: emptyLedger }));
  });

  it('honors a custom days window, clamped by the query schema', async () => {
    const { res } = makeRes();

    await call(req({ id: 'lake1', days: '7' }), res);

    expect(h.lakeUsageSummary).toHaveBeenCalledWith('lake-oid-1', 7);
  });

  it('rejects an out-of-range days value', async () => {
    const { res } = makeRes();

    await expect(call(req({ id: 'lake1', days: '9999' }), res)).rejects.toThrow();
    expect(h.lakeUsageSummary).not.toHaveBeenCalled();
  });
});
