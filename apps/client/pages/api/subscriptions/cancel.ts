import { BadRequestError } from '@bike4mind/utils';
import { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { subscriptionRepository } from '@server/models/Subscription';
import { stripe } from '@server/integrations/stripe/stripe';
import { z } from 'zod';

const CancelSubscriptionSchema = z.object({
  priceId: z.string(),
});

const handler = baseApi()
  .use(requireStripeWebhook())
  .post(async (req, res) => {
    const user = req.user;
    const { priceId } = CancelSubscriptionSchema.parse(req.body);

    if (!user?.stripeCustomerId) {
      throw new BadRequestError('User does not have a recurring subscription');
    }

    const activeSubscriptions = await subscriptionRepository.findActiveUserSubscriptions(user.id);
    if (activeSubscriptions.length === 0) {
      throw new BadRequestError('User does not have any active subscriptions to cancel');
    }

    const activePlanSubscription = activeSubscriptions.find(subscription => subscription.priceId === priceId);
    if (!activePlanSubscription) {
      throw new BadRequestError('User does not have an active subscription to the selected plan');
    }

    if (!activePlanSubscription.subscriptionId) {
      throw new BadRequestError('This subscription is not managed by Stripe and cannot be canceled here');
    }

    const subscription = await stripe.subscriptions.update(activePlanSubscription.subscriptionId, {
      cancel_at_period_end: true,
    });

    const userSubscription: Partial<IUserSubscription> = {
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      priceId,
    };

    return res.status(200).json(userSubscription);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
