import { ApiKeyScope, CREDITS_PAGE_READ } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { AdminSubscriptionByStripeIdResponse } from '@client/app/utils/adminSubscriptionDetail';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';

/** Resolves a Stripe subscription id to the Mongo id the detail page is keyed on. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: CREDITS_PAGE_READ },
}).get(
  asyncHandler<{}, unknown, unknown, { stripeSubscriptionId: string }>(async (req, res) => {
    const subscription = await subscriptionRepository.findByStripeSubscriptionId(req.query.stripeSubscriptionId);
    if (!subscription) throw new NotFoundError('Subscription not found');
    const body: AdminSubscriptionByStripeIdResponse = { id: String(subscription.id) };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(body);
  })
);

export default handler;
