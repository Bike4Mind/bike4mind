import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  resolveCanManageLake: vi.fn(),
  resolveSpendLevers: vi.fn(),
  scopeForLake: vi.fn(),
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
// scopeForLake is stubbed at the gate rather than reimplemented here - the owner derivation itself
// is covered in resolveScopedSetting.test.ts, so what this suite owns is that the endpoint FEEDS
// that owner type to the lever resolver.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    resolveCanManageLake: h.resolveCanManageLake,
    resolveSpendLevers: h.resolveSpendLevers,
  },
  scopedSettingsService: { scopeForLake: h.scopeForLake },
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
  byModel: [],
  byFeature: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
};

describe('GET /api/data-lakes/[id]/spend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.assertLakeAccess.mockResolvedValue({
      id: 'lake-oid-1',
      createdByUserId: 'u1',
      organizationId: 'org-1',
      embeddingSpendMicroUsd: 5_000_000,
    });
    h.scopeForLake.mockReturnValue({ owner: { id: 'org-1', type: CreditHolderType.Organization } });
    h.resolveCanManageLake.mockResolvedValue(true);
    h.resolveSpendLevers.mockResolvedValue({
      spendEnabled: true,
      perRunBudgetMicroUsd: 5_000_000,
      perLakeBudgetMicroUsd: 100_000_000,
      perPeriodBudgetMicroUsd: 50_000_000,
      periodHours: 24,
      tierMultiplier: 5,
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

  // The view and the ingestion gate must quote the SAME ceiling. Resolving the levers untiered here
  // would report an org lake the restrictive unknown-owner tier while the gate enforced the org one,
  // so the panel's percent-of-budget would be computed against a number nothing holds the lake to.
  it("resolves the levers at an organization-owned lake's cost tier", async () => {
    const { res, json } = makeRes();

    await call(req({ id: 'my-lake' }), res);

    expect(h.scopeForLake).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake-oid-1', organizationId: 'org-1' }));
    expect(h.resolveSpendLevers).toHaveBeenCalledWith(expect.anything(), undefined, CreditHolderType.Organization);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ tierMultiplier: 5 }));
  });

  it('resolves the levers at the individual tier for an org-less lake', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-2', createdByUserId: 'u1', organizationId: '' });
    h.scopeForLake.mockReturnValue({ owner: { id: 'u1', type: CreditHolderType.User } });
    const { res } = makeRes();

    await call(req({ id: 'my-lake' }), res);

    expect(h.resolveSpendLevers).toHaveBeenCalledWith(expect.anything(), undefined, CreditHolderType.User);
  });

  it('passes no owner type when the lake scope yields none, leaving the resolver on its restrictive tier', async () => {
    h.scopeForLake.mockReturnValue({});
    const { res } = makeRes();

    await call(req({ id: 'my-lake' }), res);

    expect(h.resolveSpendLevers).toHaveBeenCalledWith(expect.anything(), undefined, undefined);
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

  it('honors a custom days window within the schema-allowed range', async () => {
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
