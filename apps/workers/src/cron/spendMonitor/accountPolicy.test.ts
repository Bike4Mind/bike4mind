import { describe, expect, it } from 'vitest';
import type { AccountContext } from '@bike4mind/server-utils/lib/accounts/accountContext';
import { selectSpendAccountPolicy } from './accountPolicy';

const context: AccountContext = {
  accountAgeDays: 30,
  responsibleAccountAgeDays: 30,
  emailVerified: true,
  reviewState: 'none',
  riskScore: 10,
  reviewReopened: false,
  paymentRiskEvent: false,
  hasCreditPurchase: false,
  lastCreditPurchaseAgeDays: null,
  payments: {
    status: 'missing',
    succeeded: 0,
    failed: 0,
    radarBlocked: 0,
    elevatedRisk: 0,
    latestSucceededAgeDays: null,
  },
  evidence: { status: 'missing', ageHours: null },
};
const select = (facts: AccountContext | undefined = context, subscribed = true, explicitlyTrusted = false) =>
  selectSpendAccountPolicy({
    context: facts,
    subscribed,
    explicitlyTrusted,
    minimumPaidAgeDays: 7,
    riskReviewScoreThreshold: 50,
  });

describe('selectSpendAccountPolicy', () => {
  it('uses paid limits for an established subscriber and preserves unknown history as unknown', () => {
    expect(select()).toMatchObject({
      tier: 'paid',
      reasons: ['established_account', 'active_subscription'],
      context: { payments: { status: 'missing' } },
    });
  });
  it('recognizes durable unreversed purchases without an active subscription', () => {
    expect(select({ ...context, hasCreditPurchase: true, lastCreditPurchaseAgeDays: 20 }, false).tier).toBe('paid');
    expect(select(context, false).tier).toBe('standard');
    expect(select({ ...context, hasCreditPurchase: true, lastCreditPurchaseAgeDays: null }, false).tier).toBe(
      'standard'
    );
  });
  it.each<Partial<AccountContext>>([
    { accountAgeDays: 6.99 },
    { responsibleAccountAgeDays: 6.99 },
    { accountAgeDays: null },
    { emailVerified: false },
    { emailVerified: null },
    { reviewState: 'unknown' },
    { reviewState: 'pending' },
    { reviewState: 'banned' },
    { riskScore: 50 },
    { riskScore: null },
    { reviewReopened: true },
    { paymentRiskEvent: true },
    { paymentRiskEvent: null },
    { reviewReopened: null },
    { payments: { ...context.payments, status: 'observed', radarBlocked: 1 } },
    { payments: { ...context.payments, status: 'observed', elevatedRisk: 1 } },
  ])('keeps automatic limits standard with %j', patch => {
    expect(select({ ...context, ...patch }).tier).toBe('standard');
  });
  it('names a reopened review as the reason when the review is not approved', () => {
    expect(select({ ...context, reviewReopened: true })).toMatchObject({
      tier: 'standard',
      reasons: ['review_reopened'],
    });
  });
  it('applies the age boundary exactly and honors an explicit review approval over the numeric score', () => {
    expect(select({ ...context, accountAgeDays: 7, responsibleAccountAgeDays: 7 }).tier).toBe('paid');
    expect(select({ ...context, riskScore: 90, reviewState: 'approved', reviewReopened: true }).tier).toBe('paid');
  });
  it('does not use shadow evidence age or ordinary payment failures to infer abuse or cleanliness', () => {
    const facts = {
      ...context,
      evidence: { status: 'observed' as const, ageHours: 900 },
      payments: { ...context.payments, status: 'observed' as const, failed: 3 },
    };
    expect(select(facts).tier).toBe('paid');
    expect(select(facts).context?.evidence.ageHours).toBe(900);
  });
  it('allows an explicit trust exception for a new partner but never for a recorded payment risk', () => {
    expect(select({ ...context, accountAgeDays: 1 }, false, true).tier).toBe('trusted');
    expect(select({ ...context, paymentRiskEvent: true }, true, true).tier).toBe('standard');
    expect(select({ ...context, paymentRiskEvent: null, reviewReopened: null }, true, true).tier).toBe('standard');
  });
  it('keeps a pending review standard even with explicit trust', () => {
    expect(select({ ...context, reviewState: 'pending' }, true, true)).toMatchObject({
      tier: 'standard',
      reasons: ['review_pending'],
    });
  });
  describe('accounts created before signup risk scoring', () => {
    const unscored: AccountContext = { ...context, reviewState: 'unknown', riskScore: null };
    it('uses paid limits once established, naming the missing score', () => {
      expect(select(unscored)).toMatchObject({
        tier: 'paid',
        reasons: ['established_account', 'unscored_account', 'active_subscription'],
      });
      expect(select({ ...unscored, hasCreditPurchase: true, lastCreditPurchaseAgeDays: 20 }, false).reasons).toEqual([
        'established_account',
        'unscored_account',
        'unreversed_credit_purchase',
      ]);
    });
    it.each<Partial<AccountContext>>([
      { accountAgeDays: 6.99 },
      { responsibleAccountAgeDays: null },
      { emailVerified: false },
      { paymentRiskEvent: true },
      { reviewReopened: true },
      { reviewReopened: null },
      { payments: { ...context.payments, status: 'observed', radarBlocked: 1 } },
    ])('still keeps limits standard with %j', patch => {
      expect(select({ ...unscored, ...patch }).tier).toBe('standard');
    });
    it('treats a review state without a score, or a score without a review state, as unknown', () => {
      expect(select({ ...context, reviewState: 'unknown', riskScore: 10 }).reasons).toEqual(['risk_profile_unknown']);
      expect(select({ ...context, reviewState: 'none', riskScore: null }).reasons).toEqual(['risk_score_unknown']);
    });
  });
  it('fails closed when account context is unavailable, including for an explicitly trusted payer', () => {
    expect(
      selectSpendAccountPolicy({
        subscribed: true,
        explicitlyTrusted: true,
        minimumPaidAgeDays: 7,
        riskReviewScoreThreshold: 50,
      })
    ).toMatchObject({ tier: 'standard', reasons: ['account_context_unavailable'] });
  });
});
