import { describe, expect, it } from 'vitest';
import type { MrrGroup } from '../subscriptionsList/subscriptionMrr';
import { churnedWithin, revenueFacets, revenueTotalsFromFacets, toRevenueSnapshot } from './revenueSnapshot';

type Key = Record<string, unknown>;

const group = <K extends Key>(
  key: K,
  billed: number,
  count = 1,
  overrides: Partial<MrrGroup['_id']> = {}
): MrrGroup<K> => ({
  _id: { ...key, currency: 'usd', interval: 'month', intervalCount: 1, priced: true, ...overrides },
  billed,
  count,
});

const empty = { mrr: [], byPlan: [], byOwnerType: [], pastDue: [], canceling: [], newMrr: [], churned: [] };

const NOW = new Date('2026-10-30T00:15:00Z');
const DAY = { from: new Date('2026-10-29T00:00:00Z'), to: new Date('2026-10-30T00:00:00Z') };

describe('revenueFacets', () => {
  it('counts only Stripe-billed rows in an MRR status, so comps never reach a total', () => {
    const facets = revenueFacets(NOW, DAY);
    for (const name of ['mrr', 'byPlan', 'byOwnerType', 'pastDue', 'canceling', 'newMrr']) {
      expect(JSON.stringify(facets[name][0])).toContain('"source":"stripe","status":{"$in":["active","past_due"]}');
    }
  });

  it('sums churn over Stripe rows that reached canceled in the window, at their billed price', () => {
    const facets = revenueFacets(NOW, DAY);
    expect(facets.churned[0]).toEqual({ $match: churnedWithin(DAY.from, DAY.to) });
    expect(churnedWithin(DAY.from, DAY.to)).toEqual({
      source: 'stripe',
      status: 'canceled',
      $or: [
        { cancelAt: { $gte: DAY.from, $lt: DAY.to } },
        { cancelAt: null, canceledAt: { $gte: DAY.from, $lt: DAY.to } },
      ],
    });
  });

  it('groups the plan and owner breakdowns by their key', () => {
    const facets = revenueFacets(NOW, DAY);
    expect(JSON.stringify(facets.byPlan[1])).toContain('"priceId":{"$ifNull":["$priceId",null]}');
    expect(JSON.stringify(facets.byOwnerType[1])).toContain('"ownerType":{"$ifNull":["$ownerType",null]}');
  });
});

describe('revenueTotalsFromFacets', () => {
  it('normalizes yearly prices to a month and rounds the total once', () => {
    const totals = revenueTotalsFromFacets({
      ...empty,
      mrr: [group({}, 1900, 1), group({}, 19000, 1, { interval: 'year' }), group({}, 1000, 1, { interval: 'year' })],
    });
    // 1900 + 19000 / 12 + 1000 / 12 = 3566.67, rounded once.
    expect(totals.mrr).toEqual({ currency: 'usd', amount: 3567, unpriced: 0, otherCurrency: 0 });
  });

  it('counts other-currency and unpriced rows instead of summing them, and still counts them as paying', () => {
    const totals = revenueTotalsFromFacets({
      ...empty,
      mrr: [
        group({}, 1900, 2),
        group({}, 1800, 1, { currency: 'eur' }),
        group({}, 0, 3, { priced: false }),
        group({}, 0, 1, { currency: null, priced: false }),
      ],
    });
    expect(totals.mrr).toEqual({ currency: 'usd', amount: 1900, unpriced: 4, otherCurrency: 1 });
    expect(totals.payingCount).toBe(7);
  });

  it('splits MRR by plan and by owner type, largest first', () => {
    const totals = revenueTotalsFromFacets({
      ...empty,
      byPlan: [
        group({ priceId: 'price_pro' }, 1900, 1),
        group({ priceId: 'price_team' }, 4500, 3),
        group({ priceId: 'price_team' }, 0, 1, { priced: false }),
      ],
      byOwnerType: [group({ ownerType: 'User' }, 1900), group({ ownerType: 'Organization' }, 4500, 3)],
    });
    expect(totals.byPlan).toEqual([
      { key: 'price_team', count: 4, mrr: { currency: 'usd', amount: 4500, unpriced: 1, otherCurrency: 0 } },
      { key: 'price_pro', count: 1, mrr: { currency: 'usd', amount: 1900, unpriced: 0, otherCurrency: 0 } },
    ]);
    expect(totals.byOwnerType.map(entry => entry.key)).toEqual(['Organization', 'User']);
  });

  it('totals new, churned, past due and canceling MRR from their own facets', () => {
    const totals = revenueTotalsFromFacets({
      ...empty,
      newMrr: [group({}, 1900)],
      churned: [group({}, 12000, 1, { interval: 'year' })],
      pastDue: [group({}, 4500)],
      canceling: [group({}, 900)],
    });
    expect(totals.newMrr.amount).toBe(1900);
    expect(totals.churnedMrr.amount).toBe(1000);
    expect(totals.pastDueMrr.amount).toBe(4500);
    expect(totals.cancelingMrr.amount).toBe(900);
  });
});

describe('toRevenueSnapshot', () => {
  it('stores every series the Revenue charts read, keyed by the day', () => {
    const totals = revenueTotalsFromFacets({
      ...empty,
      mrr: [group({}, 1900)],
      byPlan: [group({ priceId: 'price_pro' }, 1900)],
      byOwnerType: [group({ ownerType: 'User' }, 1900)],
    });
    expect(toRevenueSnapshot('2026-10-29', NOW, totals)).toEqual({
      snapshotDate: '2026-10-29',
      computedAt: NOW,
      currency: 'usd',
      mrr: { amount: 1900, unpriced: 0, otherCurrency: 0 },
      payingCount: 1,
      mrrByPlan: [{ priceId: 'price_pro', count: 1, amount: 1900, unpriced: 0, otherCurrency: 0 }],
      mrrByOwnerType: [{ ownerType: 'User', count: 1, amount: 1900, unpriced: 0, otherCurrency: 0 }],
      newMrr: { amount: 0, unpriced: 0, otherCurrency: 0 },
      churnedMrr: { amount: 0, unpriced: 0, otherCurrency: 0 },
      pastDueMrr: { amount: 0, unpriced: 0, otherCurrency: 0 },
      cancelingMrr: { amount: 0, unpriced: 0, otherCurrency: 0 },
    });
  });
});
