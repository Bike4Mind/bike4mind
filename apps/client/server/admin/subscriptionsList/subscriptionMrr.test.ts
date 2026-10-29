import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_STATUS_FILTERS } from '@client/app/utils/adminSubscriptionsFilter';
import {
  MRR_MATCH,
  monthsPerPeriod,
  mrrGroupStages,
  mrrTotal,
  subscriptionMrr,
  type MrrFields,
  type MrrGroup,
} from './subscriptionMrr';

// A Professional plan at $19.00 a month, unless a test says otherwise.
const row = (overrides: Partial<MrrFields> = {}): MrrFields => ({
  source: 'stripe',
  status: 'active',
  quantity: 1,
  unitAmount: 1900,
  currency: 'usd',
  interval: 'month',
  intervalCount: 1,
  ...overrides,
});

const group = (overrides: Partial<MrrGroup['_id']>, billed: number, count = 1): MrrGroup => ({
  _id: { currency: 'usd', interval: 'month', intervalCount: 1, priced: true, ...overrides },
  billed,
  count,
});

describe('monthsPerPeriod', () => {
  it.each([
    ['month', 1, 1],
    ['month', 3, 3],
    ['year', 1, 12],
    ['year', 2, 24],
    ['week', 1, 12 / 52],
    ['day', 1, 12 / 365],
  ])('%s every %d is %d months', (interval, count, months) => {
    expect(monthsPerPeriod(interval, count)).toBeCloseTo(months, 10);
  });

  it('treats a missing or zero interval count as 1', () => {
    expect(monthsPerPeriod('year', null)).toBe(12);
    expect(monthsPerPeriod('year', 0)).toBe(12);
  });

  it('has no period for an unknown or missing interval', () => {
    expect(monthsPerPeriod(null, 1)).toBeNull();
    expect(monthsPerPeriod('fortnight', 1)).toBeNull();
  });
});

describe('subscriptionMrr', () => {
  it('is the monthly amount of a monthly plan', () => {
    expect(subscriptionMrr(row())).toEqual({ amount: 1900, currency: 'usd' });
  });

  it('divides a yearly amount by 12, rounded to a minor unit', () => {
    expect(subscriptionMrr(row({ unitAmount: 19900, interval: 'year' }))).toEqual({ amount: 1658, currency: 'usd' });
  });

  it('divides by the interval count', () => {
    expect(subscriptionMrr(row({ unitAmount: 5700, intervalCount: 3 }))?.amount).toBe(1900);
  });

  it('multiplies the per-seat amount by the quantity, as a Team plan bills seats', () => {
    expect(subscriptionMrr(row({ unitAmount: 3000, quantity: 8 }))?.amount).toBe(24000);
    expect(subscriptionMrr(row({ unitAmount: 30000, quantity: 8, interval: 'year' }))?.amount).toBe(20000);
  });

  it('counts past due like active', () => {
    expect(subscriptionMrr(row({ status: 'past_due' }))?.amount).toBe(1900);
  });

  it.each(SUBSCRIPTION_STATUS_FILTERS.filter(status => status !== 'active' && status !== 'past_due'))(
    'excludes %s',
    status => {
      expect(subscriptionMrr(row({ status }))).toBeNull();
    }
  );

  it('never prices a comp, even one carrying an amount', () => {
    expect(subscriptionMrr(row({ source: 'admin_grant' }))).toBeNull();
    expect(subscriptionMrr(row({ source: undefined }))).toBeNull();
  });

  it('has no amount when the mirror has none', () => {
    expect(subscriptionMrr(row({ unitAmount: null }))).toBeNull();
    expect(subscriptionMrr(row({ unitAmount: undefined, currency: undefined, interval: undefined }))).toBeNull();
    expect(subscriptionMrr(row({ interval: null }))).toBeNull();
  });

  it('keeps another currency in that currency', () => {
    expect(subscriptionMrr(row({ unitAmount: 1800, currency: 'eur' }))).toEqual({ amount: 1800, currency: 'eur' });
  });

  it('counts a $0 price as zero, not as unknown', () => {
    expect(subscriptionMrr(row({ unitAmount: 0 }))).toEqual({ amount: 0, currency: 'usd' });
  });
});

describe('mrrGroupStages', () => {
  it('matches the rows countsTowardMrr accepts, narrowed by the given view', () => {
    expect(MRR_MATCH).toEqual({ source: 'stripe', status: { $in: ['active', 'past_due'] } });
    expect(mrrGroupStages()[0]).toEqual({ $match: MRR_MATCH });
    expect(mrrGroupStages({ status: { $in: ['past_due'] } })[0]).toEqual({
      $match: { $and: [MRR_MATCH, { status: { $in: ['past_due'] } }] },
    });
  });
});

describe('mrrTotal', () => {
  it('normalizes each group to a month and rounds once after summing', () => {
    const total = mrrTotal([
      group({}, 1900 * 2, 2),
      group({ interval: 'year' }, 19900 * 3, 3),
      group({ interval: 'month', intervalCount: 3 }, 5700),
    ]);
    // 3800 + 4975 (3 x 1658.33) + 1900; rounding each row first would give 4974.
    expect(total).toEqual({ currency: 'usd', amount: 10675, unpriced: 0, otherCurrency: 0 });
  });

  it('counts rows with no amount instead of summing them', () => {
    const total = mrrTotal([
      group({}, 1900),
      group({ priced: false }, 0, 4),
      group({ priced: false, currency: null, interval: null, intervalCount: null }, 0, 2),
      group({ interval: null }, 1900),
    ]);
    expect(total).toEqual({ currency: 'usd', amount: 1900, unpriced: 7, otherCurrency: 0 });
  });

  it('counts other currencies instead of summing them', () => {
    const total = mrrTotal([group({}, 1900), group({ currency: 'eur' }, 1800, 2), group({ currency: 'gbp' }, 1500)]);
    expect(total).toEqual({ currency: 'usd', amount: 1900, unpriced: 0, otherCurrency: 3 });
  });

  it('is zero with nothing to sum', () => {
    expect(mrrTotal([])).toEqual({ currency: 'usd', amount: 0, unpriced: 0, otherCurrency: 0 });
  });
});
