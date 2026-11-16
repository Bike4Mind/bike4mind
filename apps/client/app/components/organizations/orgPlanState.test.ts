import { SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { describe, expect, it } from 'vitest';
import { getOrgPlanState, isLiveOrgPlan, orgPlanChipColor } from './orgPlanState';

const sub = (over: Record<string, unknown> = {}) =>
  ({ status: 'active', canceledAt: null, source: SubscriptionSource.Stripe, ...over }) as Parameters<
    typeof getOrgPlanState
  >[0];

describe('getOrgPlanState', () => {
  it('is none without a subscription', () => {
    expect(getOrgPlanState(undefined)).toBe('none');
    expect(getOrgPlanState(null)).toBe('none');
  });

  it('reports a delinquent subscription as a payment issue, even one that is ending', () => {
    expect(getOrgPlanState(sub({ status: 'past_due', cancelAt: new Date() }))).toBe('payment_issue');
  });

  it('treats a canceled subscription as no plan', () => {
    expect(getOrgPlanState(sub({ canceledAt: new Date() }))).toBe('none');
  });

  it('reports a scheduled cancel as ending, by date or at period end', () => {
    expect(getOrgPlanState(sub({ cancelAt: new Date() }))).toBe('ending');
    expect(getOrgPlanState(sub({ cancelAtPeriodEnd: true }))).toBe('ending');
  });

  it('reports a trial', () => {
    expect(getOrgPlanState(sub({ status: 'trialing' }))).toBe('trialing');
  });

  it('reports an admin grant, including a legacy one known only by its subscription id', () => {
    expect(getOrgPlanState(sub({ source: SubscriptionSource.AdminGrant }))).toBe('granted');
    expect(getOrgPlanState(sub({ source: undefined, subscriptionId: 'admin_granted_1' }))).toBe('granted');
  });

  it('reports a paid subscription as active', () => {
    expect(getOrgPlanState(sub())).toBe('active');
  });
});

describe('plan state display', () => {
  it('reads only live plans as success', () => {
    expect(isLiveOrgPlan('none')).toBe(false);
    expect(isLiveOrgPlan('payment_issue')).toBe(false);
    expect(orgPlanChipColor('active')).toBe('success');
    expect(orgPlanChipColor('granted')).toBe('success');
    expect(orgPlanChipColor('ending')).toBe('warning');
    expect(orgPlanChipColor('payment_issue')).toBe('danger');
    expect(orgPlanChipColor('none')).toBe('neutral');
  });
});
