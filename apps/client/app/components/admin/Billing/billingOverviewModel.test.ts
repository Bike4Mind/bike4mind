import { describe, expect, it } from 'vitest';
import { billingLinkHref, subscriptionNextDate, windowStartsBefore } from './billingOverviewModel';

const subscription = {
  id: 's1',
  planName: 'Pro',
  status: 'active',
  source: 'stripe' as const,
  comped: false,
  quantity: 1,
  periodEndsAt: '2026-12-01T00:00:00.000Z',
  cancelAt: null,
  canceledAt: null,
  createdAt: null,
};

describe('billingLinkHref', () => {
  it('points each record at the page that owns it', () => {
    expect(billingLinkHref({ kind: 'subscription', subscriptionId: 'abc', tab: 'invoices' })).toBe(
      '/admin/subscriptions/abc?tab=invoices'
    );
    expect(billingLinkHref({ kind: 'subscription', subscriptionId: 'abc', tab: 'overview' })).toBe(
      '/admin/subscriptions/abc'
    );
    expect(billingLinkHref({ kind: 'userCredits', userId: 'u1' })).toBe('/admin/users/u1?tab=credits');
    expect(billingLinkHref({ kind: 'organization', organizationId: 'o1' })).toBe('/admin?tab=organizations&orgId=o1');
    expect(billingLinkHref({ kind: 'disputes' })).toBe('/admin?tab=disputes');
  });

  it('opens the Activity tab on spend over the same days as the overview', () => {
    expect(billingLinkHref({ kind: 'userActivity', userId: 'u1', from: '2026-08-03', to: '2026-11-01' })).toBe(
      '/admin/users/u1?tab=activity&types=usage%2Cspend&from=2026-08-03&to=2026-11-01'
    );
  });
});

describe('subscriptionNextDate', () => {
  it('reads a renewal, a scheduled end and a comp end', () => {
    expect(subscriptionNextDate(subscription)).toEqual({ label: 'Renews', at: subscription.periodEndsAt });
    expect(subscriptionNextDate({ ...subscription, cancelAt: '2026-11-20T00:00:00.000Z' })).toEqual({
      label: 'Ends',
      at: '2026-11-20T00:00:00.000Z',
    });
    expect(subscriptionNextDate({ ...subscription, comped: true })?.label).toBe('Comp ends');
    expect(subscriptionNextDate({ ...subscription, periodEndsAt: null })).toBeNull();
  });
});

describe('windowStartsBefore', () => {
  it('flags a window that reaches back before a store began', () => {
    expect(windowStartsBefore('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe(true);
    expect(windowStartsBefore('2026-07-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe(false);
    expect(windowStartsBefore('2026-07-01T00:00:00Z', null)).toBe(false);
  });
});
