import type { AccountContext } from '@bike4mind/server-utils/lib/accounts/accountContext';
import type { AccountTier } from './rules';

export type SpendAccountPolicy = { tier: AccountTier; reasons: string[]; context?: AccountContext };

/** Monitoring policy only; this never changes access, billing, or young-account enforcement. */
export function selectSpendAccountPolicy(input: {
  context?: AccountContext;
  subscribed: boolean;
  explicitlyTrusted: boolean;
  minimumPaidAgeDays: number;
  riskReviewScoreThreshold: number;
}): SpendAccountPolicy {
  const { context, subscribed, explicitlyTrusted, minimumPaidAgeDays, riskReviewScoreThreshold } = input;
  const decide = (tier: AccountTier, reasons: string[]): SpendAccountPolicy => ({ tier, reasons, context });
  if (!context) return decide('standard', ['account_context_unavailable']);

  const risks = [
    ...(context.paymentRiskEvent === true ? ['payment_risk_event'] : []),
    ...(context.reviewReopened === true && context.reviewState !== 'approved' ? ['review_reopened'] : []),
    ...(['pending', 'banned'].includes(context.reviewState) ? [`review_${context.reviewState}`] : []),
    ...(context.reviewState !== 'approved' &&
    context.riskScore !== null &&
    context.riskScore >= riskReviewScoreThreshold
      ? ['risk_score_requires_review']
      : []),
    ...(context.payments.radarBlocked > 0 ? ['payment_blocked'] : []),
    ...(context.payments.elevatedRisk > 0 ? ['payment_elevated_risk'] : []),
  ];
  if (risks.length > 0) return decide('standard', risks);
  if (context.paymentRiskEvent === null || context.reviewReopened === null) {
    return decide('standard', ['risk_flags_unknown']);
  }
  // Explicit operator trust can accommodate a new partner, but never overrides recorded risk flags.
  if (explicitlyTrusted) return decide('trusted', ['explicit_trust']);
  // Accounts created before signup risk scoring have no score; past the minimum age that absence is
  // not a risk signal, while every recorded risk flag above still applies.
  const unscored = context.reviewState === 'unknown' && context.riskScore === null;
  const reasons = [
    ...(context.emailVerified !== true ? ['email_not_verified'] : []),
    ...(context.accountAgeDays === null || context.responsibleAccountAgeDays === null
      ? ['account_age_unknown']
      : Math.min(context.accountAgeDays, context.responsibleAccountAgeDays) < minimumPaidAgeDays
        ? ['account_young']
        : []),
    ...(context.reviewState === 'unknown' && !unscored ? ['risk_profile_unknown'] : []),
    ...(context.reviewState !== 'approved' && context.riskScore === null && !unscored ? ['risk_score_unknown'] : []),
  ];
  if (reasons.length > 0) return decide('standard', reasons);
  const established = unscored ? ['established_account', 'unscored_account'] : ['established_account'];
  if (subscribed) return decide('paid', [...established, 'active_subscription']);
  if (context.hasCreditPurchase === true && context.lastCreditPurchaseAgeDays !== null)
    return decide('paid', [...established, 'unreversed_credit_purchase']);
  return decide('standard', ['no_paid_standing']);
}
