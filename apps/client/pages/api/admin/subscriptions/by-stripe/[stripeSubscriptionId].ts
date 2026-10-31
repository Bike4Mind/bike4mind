import { ApiKeyScope } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import type { AdminSubscriptionByStripeIdResponse } from '@client/app/utils/adminSubscriptionDetail';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';

/** Resolves a Stripe subscription id to the Mongo id the detail page is keyed on. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler<{}, unknown, unknown, { stripeSubscriptionId: string }>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const subscription = await subscriptionRepository.findByStripeSubscriptionId(req.query.stripeSubscriptionId);
    if (!subscription) throw new NotFoundError('Subscription not found');
    const body: AdminSubscriptionByStripeIdResponse = { id: String(subscription.id) };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(body);
  })
);

export default handler;
