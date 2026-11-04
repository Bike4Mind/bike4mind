import { describe, expect, it } from 'vitest';
import {
  diffSubscription,
  GRACE_MS,
  isStageSubscription,
  withinGrace,
  type ComparableRow,
} from './compareSubscription';

const PERIOD_END = 1_702_592_000;

const stripeSub = (overrides: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
  ({
    id: 'sub_1',
    status: 'active',
    canceled_at: null,
    currency: 'usd',
    customer: 'cus_1',
    cancel_at_period_end: false,
    cancel_at: null,
    trial_end: null,
    created: 1_690_000_000,
    items: {
      data: [
        {
          price: {
            id: 'price_1',
            unit_amount: 2000,
            currency: 'usd',
            recurring: { interval: 'month', interval_count: 1 },
          },
          current_period_start: 1_700_000_000,
          current_period_end: PERIOD_END,
          quantity: 3,
          ...item,
        },
      ],
    },
    ...overrides,
  }) as never;

const row = (overrides: Partial<ComparableRow> = {}): ComparableRow => ({
  status: 'active',
  priceId: 'price_1',
  quantity: 3,
  periodEndsAt: new Date(PERIOD_END * 1000),
  cancelAtPeriodEnd: false,
  unitAmount: 2000,
  ...overrides,
});

describe('diffSubscription', () => {
  it('compares seats only for a subscription that bills them', () => {
    expect(diffSubscription(row(), stripeSub(), 10)).toEqual([{ field: 'seats', mongo: '10', stripe: '3' }]);
    expect(diffSubscription(row({ status: 'incomplete' }), stripeSub({ status: 'incomplete' }), 10)).toEqual([]);
  });

  it('returns nothing for equal rows', () => {
    expect(diffSubscription(row(), stripeSub())).toEqual([]);
  });

  it.each([
    ['status', row({ status: 'past_due' }), stripeSub(), { field: 'status', mongo: 'past_due', stripe: 'active' }],
    [
      'priceId',
      row({ priceId: 'price_old' }),
      stripeSub(),
      { field: 'priceId', mongo: 'price_old', stripe: 'price_1' },
    ],
    ['quantity', row({ quantity: 1 }), stripeSub(), { field: 'quantity', mongo: '1', stripe: '3' }],
    [
      'periodEndsAt',
      row({ periodEndsAt: new Date((PERIOD_END - 86_400) * 1000) }),
      stripeSub(),
      { field: 'periodEndsAt', mongo: String(PERIOD_END - 86_400), stripe: String(PERIOD_END) },
    ],
    [
      'cancelAtPeriodEnd',
      row({ cancelAtPeriodEnd: true }),
      stripeSub(),
      { field: 'cancelAtPeriodEnd', mongo: 'true', stripe: 'false' },
    ],
    ['unitAmount', row({ unitAmount: 1500 }), stripeSub(), { field: 'unitAmount', mongo: '1500', stripe: '2000' }],
  ])('flags %s', (_name, r, s, expected) => {
    expect(diffSubscription(r, s)).toEqual([expected]);
  });

  it('ignores a sub-second difference in the period end', () => {
    expect(diffSubscription(row({ periodEndsAt: new Date(PERIOD_END * 1000 + 400) }), stripeSub())).toEqual([]);
  });

  it('does not flag a mirror field the row never recorded', () => {
    expect(diffSubscription(row({ cancelAtPeriodEnd: undefined, unitAmount: undefined }), stripeSub())).toEqual([]);
  });

  it('flags organization seats that differ from the billed quantity', () => {
    expect(diffSubscription(row(), stripeSub(), 5)).toEqual([{ field: 'seats', mongo: '5', stripe: '3' }]);
    expect(diffSubscription(row(), stripeSub(), 3)).toEqual([]);
  });
});

describe('isStageSubscription', () => {
  it('matches the stamped stage', () => {
    expect(isStageSubscription({ metadata: { stage: 'dev' } }, 'dev')).toBe(true);
    expect(isStageSubscription({ metadata: { stage: 'production' } }, 'dev')).toBe(false);
  });

  it('claims an unstamped subscription for production only', () => {
    expect(isStageSubscription({ metadata: {} }, 'production')).toBe(true);
    expect(isStageSubscription({ metadata: {} }, 'dev')).toBe(false);
  });
});

describe('withinGrace', () => {
  const now = new Date('2026-11-04T06:30:00Z');
  const old = Math.floor(now.getTime() / 1000) - 10 * 86_400;

  it('skips a row or Stripe subscription touched inside the window', () => {
    expect(withinGrace({ updatedAt: new Date(now.getTime() - GRACE_MS + 1000) }, { created: old }, now)).toBe(true);
    expect(withinGrace(null, { created: Math.floor(now.getTime() / 1000) - 60 }, now)).toBe(true);
  });

  it('does not skip settled rows', () => {
    expect(withinGrace({ updatedAt: new Date(now.getTime() - 2 * GRACE_MS) }, { created: old }, now)).toBe(false);
  });
});
