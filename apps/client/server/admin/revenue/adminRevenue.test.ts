import { describe, expect, it, vi } from 'vitest';
import type { IRevenueSnapshotDocument } from '@bike4mind/database';
import type { PlanCatalog } from '../subscriptionsList/adminSubscriptionsQuery';

vi.mock('@bike4mind/database', () => ({
  convertPipelineForDocumentDB: vi.fn(),
  mongoose: {},
  revenueSnapshotRepository: {},
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({ Subscription: {} }));
vi.mock('../subscriptionsList/listAdminSubscriptions', () => ({ toAdminSubscriptionRows: vi.fn() }));
vi.mock('./revenueSnapshot', () => ({ computeRevenueTotals: vi.fn() }));

import { toTrendPoint, trendPlans } from './adminRevenue';

const mrr = (amount: number) => ({ amount, unpriced: 0, otherCurrency: 0 });

const snapshot = (overrides: Partial<IRevenueSnapshotDocument> = {}) =>
  ({
    snapshotDate: '2026-10-29',
    computedAt: new Date('2026-10-30T00:20:00Z'),
    currency: 'usd',
    mrr: mrr(5_000),
    payingCount: 3,
    mrrByPlan: [
      { priceId: 'price_pro', count: 2, ...mrr(3_800) },
      { priceId: null, count: 1, ...mrr(1_200) },
    ],
    mrrByOwnerType: [
      { ownerType: 'User', count: 2, ...mrr(3_800) },
      { ownerType: 'Organization', count: 1, ...mrr(1_200) },
    ],
    newMrr: mrr(1_900),
    churnedMrr: mrr(900),
    pastDueMrr: mrr(1_900),
    cancelingMrr: mrr(0),
    ...overrides,
  }) as IRevenueSnapshotDocument;

describe('toTrendPoint', () => {
  it('flattens a snapshot into the chart fields, keying a missing price id as none', () => {
    expect(toTrendPoint(snapshot())).toEqual({
      date: '2026-10-29',
      mrr: 5_000,
      payingCount: 3,
      newMrr: 1_900,
      churnedMrr: 900,
      pastDueMrr: 1_900,
      cancelingMrr: 0,
      payingUsers: 2,
      payingOrgs: 1,
      mrrByPlan: { price_pro: 3_800, none: 1_200 },
    });
  });

  it('reads zero for an owner type with no paying rows', () => {
    expect(toTrendPoint(snapshot({ mrrByOwnerType: [] }))).toMatchObject({ payingUsers: 0, payingOrgs: 0 });
  });
});

describe('trendPlans', () => {
  it('orders plans by MRR on the last day, then by peak, and names them from the catalog', () => {
    const catalog: PlanCatalog = new Map([['price_pro', { name: 'Pro', interval: 'monthly' as const }]]);
    const points = [
      toTrendPoint(snapshot({ snapshotDate: '2026-10-28', mrrByPlan: [{ priceId: 'gone', count: 1, ...mrr(9_000) }] })),
      toTrendPoint(snapshot()),
    ];
    expect(trendPlans(points, catalog)).toEqual([
      { key: 'price_pro', plan: { priceId: 'price_pro', name: 'Pro', interval: 'monthly' } },
      { key: 'none', plan: { priceId: null, name: null, interval: null } },
      { key: 'gone', plan: { priceId: 'gone', name: null, interval: null } },
    ]);
  });
});
