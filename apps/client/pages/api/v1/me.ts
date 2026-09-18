/**
 * GET /api/v1/me - the caller's own identity and commercial state.
 *
 * The subject is strictly `req.user`: this handler reads no id from the query,
 * body, or path, so a credential can only ever describe its own owner.
 */

import { getMeContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getUserEntitlements } from '@server/entitlements';
import { subscriptionRepository } from '@server/models/Subscription';
import { resolveCallerPlan } from '@server/me/resolveCallerPlan';

const handler = nextRouteForContract(getMeContract, {
  // A client polling its own balance between calls should cost one daily slot,
  // not one per poll. The per-minute burst limit still applies.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { user } = req;

  // One read feeds both projections, so `tier` and `entitlements` cannot disagree
  // about whether the caller is paying (they resolve the priceId through different
  // tables - see resolveCallerPlan).
  const active = await subscriptionRepository.findActiveUserSubscriptions(user.id);
  const { tier, subscription } = resolveCallerPlan(active);
  const entitlements = await getUserEntitlements(
    {
      id: user.id,
      tags: user.tags,
      isAdmin: user.isAdmin,
      email: user.email,
      emailVerified: user.emailVerified,
    },
    active
  );

  // User-specific payload behind CloudFront - never cacheable, anywhere.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    id: user.id,
    name: user.name,
    tier,
    subscription,
    credits: { balance: user.currentCredits },
    entitlements,
  });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
