import { describe, expect, it } from 'vitest';
import { stripeStateToken } from './adminSubscriptionDetail';

const base = {
  status: 'active',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  periodEndsAt: '2026-12-01T00:00:00.000Z',
};

describe('stripeStateToken', () => {
  it.each([
    ['status', { status: 'past_due' }],
    ['cancelAtPeriodEnd', { cancelAtPeriodEnd: true }],
    ['cancelAt', { cancelAt: '2027-03-01T00:00:00.000Z' }],
    ['periodEndsAt', { periodEndsAt: '2026-12-02T00:00:00.000Z' }],
  ])('changes when only %s changes', (_field, change) => {
    expect(stripeStateToken({ ...base, ...change })).not.toBe(stripeStateToken(base));
  });

  it('ignores lastSyncedAt, which our own webhook re-stamps', () => {
    const stamped = { ...base, lastSyncedAt: new Date('2026-11-04T10:00:00.000Z') };
    expect(stripeStateToken(stamped)).toBe(stripeStateToken(base));
  });

  it('gives a Date and its ISO string the same token', () => {
    const asDates = { ...base, periodEndsAt: new Date(base.periodEndsAt), cancelAt: new Date('2027-03-01T00:00:00Z') };
    const asStrings = { ...base, periodEndsAt: base.periodEndsAt, cancelAt: '2027-03-01T00:00:00.000Z' };
    expect(stripeStateToken(asDates)).toBe(stripeStateToken(asStrings));
  });
});
