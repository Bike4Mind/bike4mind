/**
 * GET /api/v1/me - the caller's own identity and commercial state.
 *
 * The subject is strictly `req.user`: this handler reads no id from the query,
 * body, or path, so a credential can only ever describe its own owner.
 */

import { CreditHolderType, getMeContract, pendingCreditExpiries } from '@bike4mind/common';
import { creditLotRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getUserEntitlements, toEntitlementUser } from '@bike4mind/server-utils/entitlements/index';
import { getRequestActiveSubscriptions } from '@bike4mind/server-utils/entitlements/activeSubscriptions';
import { resolveCallerPlan } from '@server/me/resolveCallerPlan';

const handler = nextRouteForContract(getMeContract, {
  // A client polling its own balance between calls should cost one daily slot,
  // not one per poll. The per-minute burst limit still applies.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { user } = req;

  // `tier` and `entitlements` are derived from one snapshot read of the caller's
  // active subscriptions, org seats included (they resolve the priceId through
  // different tables - see resolveCallerPlan), rather than two reads that could race apart.
  const active = await getRequestActiveSubscriptions(req);
  const { tier, subscription, personalMonthlyCreditAllowance } = resolveCallerPlan(active);
  const [entitlements, lots] = await Promise.all([
    getUserEntitlements(toEntitlementUser(user), active),
    creditLotRepository.findByOwner(user.id, CreditHolderType.User),
  ]);
  const expiring = pendingCreditExpiries(lots, user.currentCredits).map(({ amount, expiresAt }) => ({
    amount,
    expires_at: expiresAt.toISOString(),
  }));

  // User-specific payload behind CloudFront - never cacheable, anywhere.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    id: user.id,
    name: user.name,
    tier,
    subscription,
    credits: { balance: user.currentCredits, monthly_allowance: personalMonthlyCreditAllowance, expiring },
    entitlements,
  });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
