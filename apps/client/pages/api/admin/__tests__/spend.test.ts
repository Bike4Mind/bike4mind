import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { ISpendSummary } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    return chain;
  },
}));

const mockSpendSummary = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { spendSummary: (...a: unknown[]) => mockSpendSummary(...a) },
  cacheRepository: {},
}));

const mockOrgFind = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { find: (...a: unknown[]) => mockOrgFind(...a) },
}));

// Pass the factory straight through so buildSpendData actually runs (no real cache),
// while capturing the key/options so the recache plumbing is testable.
const mockGetCachedData = vi.fn((_key: string, factory: () => unknown) => factory());
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: (...a: unknown[]) => mockGetCachedData(...(a as [string, () => unknown])) },
}));

const mockResolveUserNames = vi.fn();
vi.mock('@server/utils/resolveUserNames', () => ({
  resolveUserNames: (...a: unknown[]) => mockResolveUserNames(...a),
}));

import handler from '../spend';

const summary = (over: Partial<ISpendSummary> = {}): ISpendSummary => ({
  totals: { requests: 100, cogsUsd: 20, creditsCharged: 2000 },
  activeAccounts: 3,
  latency: { p50: 500, p95: 1500 },
  status: { total: 100, errors: 2, timeouts: 1, refusals: 5 },
  byModel: [{ provider: 'bedrock', model: 'opus', requests: 60, cogsUsd: 12, creditsCharged: 1200 }],
  byAccount: [{ ownerId: 'user-1', ownerType: 'User', requests: 100, cogsUsd: 20, creditsCharged: 2000 } as never],
  dailyCost: [{ day: '2026-08-01', cogsUsd: 20 }],
  ...over,
});

function call(options: { isAdmin?: boolean; query?: object }) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? {} });
  (req as unknown as { user?: { isAdmin: boolean; id: string }; logger: unknown }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/spend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpendSummary.mockResolvedValue(summary());
    mockOrgFind.mockResolvedValue([]);
    mockResolveUserNames.mockResolvedValue(new Map([['user-1', 'Ada Lovelace']]));
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockSpendSummary).not.toHaveBeenCalled();
  });

  it('queries a current and a prior window of equal length', async () => {
    const { run } = call({ query: { dateFrom: '2026-07-08', dateTo: '2026-08-07' } });
    await run();

    expect(mockSpendSummary).toHaveBeenCalledTimes(2);
    const [current] = mockSpendSummary.mock.calls[0];
    const [prior] = mockSpendSummary.mock.calls[1];
    const windowMs = current.to.getTime() - current.from.getTime();
    // Prior window abuts the current one and is the same length.
    expect(prior.to.getTime()).toBe(current.from.getTime());
    expect(current.from.getTime() - prior.from.getTime()).toBe(windowMs);
  });

  it('maps user/model filters into the repository call', async () => {
    const { run } = call({ query: { userFilter: 'u-9', modelFilter: 'opus' } });
    await run();
    expect(mockSpendSummary.mock.calls[0][0]).toMatchObject({ userId: 'u-9', model: 'opus' });
  });

  it('shapes SpendData: derived KPIs, resolved account name, and model share', async () => {
    const { res, run } = call({ query: {} });
    await run();
    const data = res._getJSONData();

    const byKey = Object.fromEntries(data.kpis.map((k: { key: string; value: number }) => [k.key, k.value]));
    expect(byKey.estCost).toBe(20);
    expect(byKey.costPerRequest).toBeCloseTo(0.2); // 20 / 100
    // errorRate folds timeouts in: (2 + 1) / 100.
    expect(byKey.errorRate).toBeCloseTo(0.03);
    // refusalRate is its own bucket: 5 / 100.
    expect(byKey.refusalRate).toBeCloseTo(0.05);

    expect(data.byAccount[0]).toMatchObject({ accountId: 'user-1', accountName: 'Ada Lovelace' });
    // modelId keys on provider+model so distinct backends serving the same model don't merge.
    expect(data.byModel[0]).toMatchObject({ modelId: 'bedrock/opus', modelName: 'bedrock / opus', share: 12 / 20 });
    expect(data.periodLabel).toBe('Last 30 days');
    // Authoritative empty/truncation signals emitted on the contract, not inferred.
    expect(data.hasData).toBe(true);
    expect(data.activeAccounts).toBe(3);
  });

  it('feeds the current summary to KPI values and the prior summary to priorValues', async () => {
    // Distinct fixtures per window so a swapped argument order (or reading a KPI
    // from the wrong summary) can't pass. Order matches buildSpendData's Promise.all.
    mockSpendSummary
      .mockResolvedValueOnce(summary({ totals: { requests: 100, cogsUsd: 20, creditsCharged: 2000 } }))
      .mockResolvedValueOnce(summary({ totals: { requests: 50, cogsUsd: 8, creditsCharged: 900 } }));

    const { res, run } = call({ query: {} });
    await run();

    const estCost = res._getJSONData().kpis.find((k: { key: string }) => k.key === 'estCost');
    expect(estCost).toMatchObject({ value: 20, priorValue: 8 });
  });

  it('reports hasData=false when the window has no requests', async () => {
    mockSpendSummary.mockResolvedValue(
      summary({ totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 }, activeAccounts: 0, byAccount: [] })
    );
    const { res, run } = call({ query: {} });
    await run();
    expect(res._getJSONData().hasData).toBe(false);
  });

  it('threads recache=true through to the cache envelope', async () => {
    const { run } = call({ query: { recache: 'true' } });
    await run();
    expect(mockGetCachedData.mock.calls[0][2]).toMatchObject({ recache: true });
  });

  it('does not bust the cache for a non-true recache value', async () => {
    const { run } = call({ query: { recache: 'false' } });
    await run();
    expect(mockGetCachedData.mock.calls[0][2]).toMatchObject({ recache: false });
  });

  it('rejects an inverted date range instead of silently blanking the deltas', async () => {
    const { run } = call({ query: { dateFrom: '2026-08-07', dateTo: '2026-07-08' } });
    await expect(run()).rejects.toThrow(/dateFrom must not be after dateTo/);
    expect(mockSpendSummary).not.toHaveBeenCalled();
  });

  it('resolves organization owners to their org name', async () => {
    mockSpendSummary.mockResolvedValue(
      summary({
        byAccount: [
          {
            ownerId: '6650000000000000000000aa',
            ownerType: 'Organization',
            requests: 10,
            cogsUsd: 5,
            creditsCharged: 500,
          } as never,
        ],
      })
    );
    mockOrgFind.mockResolvedValue([{ id: '6650000000000000000000aa', name: 'Northwind Labs' }]);

    const { res, run } = call({ query: {} });
    await run();
    expect(res._getJSONData().byAccount[0].accountName).toBe('Northwind Labs');
  });
});
