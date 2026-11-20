import { describe, expect, it } from 'vitest';
import type { RevenueTrendPoint } from '@bike4mind/server-utils/app/utils/adminRevenue';
import {
  OTHER_PLANS_KEY,
  atRiskTakeaway,
  movementTakeaway,
  ownerTakeaway,
  periodLabel,
  periodStart,
  planSeries,
  planTakeaway,
  toPeriods,
  toPlanPoints,
} from './revenueChartData';

const point = (date: string, overrides: Partial<RevenueTrendPoint> = {}): RevenueTrendPoint => ({
  date,
  mrr: 0,
  payingCount: 0,
  newMrr: 0,
  churnedMrr: 0,
  pastDueMrr: 0,
  cancelingMrr: 0,
  payingUsers: 0,
  payingOrgs: 0,
  mrrByPlan: {},
  ...overrides,
});

const plan = (key: string, name: string | null = key) => ({
  key,
  plan: { priceId: key, name, interval: null },
});

describe('periodStart', () => {
  it('starts weeks on Monday and months on the first, in UTC', () => {
    expect(periodStart('2026-10-28', 'day')).toBe('2026-10-28');
    // Wednesday, Sunday and Monday.
    expect(periodStart('2026-10-28', 'week')).toBe('2026-10-26');
    expect(periodStart('2026-11-01', 'week')).toBe('2026-10-26');
    expect(periodStart('2026-11-02', 'week')).toBe('2026-11-02');
    expect(periodStart('2026-10-28', 'month')).toBe('2026-10-01');
  });

  it('labels each unit', () => {
    expect(periodLabel('2026-10-26', 'day')).toBe('Oct 26');
    expect(periodLabel('2026-10-26', 'week')).toBe('Week of Oct 26');
    expect(periodLabel('2026-10-01', 'month')).toBe('Oct 2026');
  });
});

describe('toPeriods', () => {
  it('sums movement over a period and keeps the last day of customers', () => {
    const periods = toPeriods(
      [
        point('2026-09-30', { newMrr: 500, payingUsers: 1 }),
        point('2026-10-01', { newMrr: 1_000, churnedMrr: 200, payingUsers: 2, payingOrgs: 1 }),
        point('2026-10-15', { newMrr: 300, churnedMrr: 900, payingUsers: 3, payingOrgs: 0 }),
      ],
      'month'
    );
    expect(periods).toEqual([
      {
        start: '2026-09-01',
        label: 'Sep 2026',
        newMrr: 500,
        churnedMrr: 0,
        net: 500,
        payingUsers: 1,
        payingOrgs: 0,
      },
      {
        start: '2026-10-01',
        label: 'Oct 2026',
        newMrr: 1_300,
        churnedMrr: 1_100,
        net: 200,
        payingUsers: 3,
        payingOrgs: 0,
      },
    ]);
  });
});

describe('planSeries and toPlanPoints', () => {
  it('names up to five plans and folds the rest into Other plans', () => {
    expect(planSeries([plan('a'), plan('b', null)]).map(entry => entry.label)).toEqual(['a', 'Unknown plan']);
    expect(planSeries(['a', 'b', 'c', 'd', 'e'].map(key => plan(key))).map(entry => entry.key)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(planSeries(['a', 'b', 'c', 'd', 'e', 'f'].map(key => plan(key))).map(entry => entry.key)).toEqual([
      'a',
      'b',
      'c',
      'd',
      OTHER_PLANS_KEY,
    ]);
  });

  it('sums the folded plans into Other plans and totals every plan', () => {
    const series = planSeries(['a', 'b', 'c', 'd', 'e', 'f'].map(key => plan(key)));
    const [day] = toPlanPoints([point('2026-10-29', { mrrByPlan: { a: 100, e: 20, f: 5 } })], series);
    expect(day.total).toBe(125);
    expect(day.values).toEqual({ a: 100, b: 0, c: 0, d: 0, [OTHER_PLANS_KEY]: 25 });
  });
});

describe('takeaways', () => {
  it('summarizes movement, including a range with none', () => {
    const period = (newMrr: number, churnedMrr: number) => ({
      start: '2026-10-01',
      label: 'Oct 1',
      newMrr,
      churnedMrr,
      net: newMrr - churnedMrr,
      payingUsers: 0,
      payingOrgs: 0,
    });
    expect(movementTakeaway([period(0, 0)])).toBe('No new or churned MRR in this range.');
    expect(movementTakeaway([period(5_000, 1_900), period(0, 1_000)])).toBe(
      'Net +$21.00 MRR in this range: $50.00 new, $29.00 churned.'
    );
    expect(movementTakeaway([period(1_000, 1_900)])).toBe('Net -$9.00 MRR in this range: $10.00 new, $19.00 churned.');
    expect(movementTakeaway([period(1_000, 1_000)])).toBe(
      'New and churned MRR cancel out in this range: $10.00 new, $10.00 churned.'
    );
  });

  it('names the largest plan, ignoring Other plans', () => {
    const series = planSeries([plan('pro', 'Pro'), plan('team', 'Team')]);
    const points = toPlanPoints([point('2026-10-29', { mrrByPlan: { pro: 250, team: 750 } })], series);
    expect(planTakeaway(points, series)).toBe('Team is 75% of MRR on Oct 29.');
    expect(planTakeaway(toPlanPoints([point('2026-10-29')], series), series)).toBe('No MRR on Oct 29.');
  });

  it('splits paying customers and at-risk MRR on the last day', () => {
    const last = point('2026-10-29', {
      payingCount: 1_200,
      payingUsers: 1_150,
      payingOrgs: 50,
      pastDueMrr: 1_900,
      cancelingMrr: 4_900,
    });
    expect(ownerTakeaway([last])).toBe('1,200 paying on Oct 29: 1,150 individuals, 50 organizations.');
    expect(atRiskTakeaway([last])).toBe('$19.00 past due and $49.00 canceling on Oct 29. A row can be both.');
    expect(atRiskTakeaway([point('2026-10-29')])).toBe('No MRR past due or canceling on Oct 29.');
  });
});
