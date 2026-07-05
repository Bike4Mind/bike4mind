import { BadRequestError } from '@bike4mind/utils';
import { subscriptionPlanSchema } from '@client/lib/userSubscriptions/schemas';
import { SubscriptionPlanInterval } from '@client/lib/userSubscriptions/types';
import { getSubscriptionPlanByPriceId } from '@client/lib/userSubscriptions/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { subscriptionRepository } from '@server/models/Subscription';
import { stripe } from '@server/integrations/stripe/stripe';
import { Request } from 'express';
import { z } from 'zod';

type RequestBody = z.infer<typeof subscriptionPlanSchema>;

const handler = baseApi()
  .use(requireStripeWebhook())
  .put<Request<unknown, unknown, RequestBody>>(async (req, res) => {
    const userId = req.user?.id;
    const { priceId } = subscriptionPlanSchema.parse(req.body);

    const activeSubscriptions = await subscriptionRepository.findActiveUserSubscriptions(userId);
    if (!activeSubscriptions.length) {
      throw new BadRequestError('User does not have an active subscription');
    }

    const [activeSubscription] = activeSubscriptions;

    if (activeSubscription.priceId === priceId) {
      throw new BadRequestError('User is already subscribed to this plan');
    }

    if (!activeSubscription.subscriptionId) {
      throw new BadRequestError('This subscription is not managed by Stripe and cannot be changed here');
    }

    const activeSubscriptionInfo = getSubscriptionPlanByPriceId(activeSubscription.priceId);
    const newSubscriptionInfo = getSubscriptionPlanByPriceId(priceId);
    if (!activeSubscriptionInfo || !newSubscriptionInfo) {
      throw new BadRequestError('Invalid subscription plan');
    }

    // Tier comparison only makes sense within the B4M plan ladder. A plan with no
    // tier (e.g. a standalone, single-tier product) isn't on that ladder - reject
    // rather than letting two same-tier plans from different products silently swap.
    if (activeSubscriptionInfo.tier === undefined || newSubscriptionInfo.tier === undefined) {
      throw new BadRequestError('This plan cannot be changed here');
    }

    const activeStripeSubscriptionId = activeSubscription.subscriptionId;
    const currentStripeSubscription = await stripe.subscriptions.retrieve(activeStripeSubscriptionId);

    const isSameTier = activeSubscriptionInfo.tier === newSubscriptionInfo.tier;
    const isSameInterval = activeSubscriptionInfo.interval === newSubscriptionInfo.interval;
    const isMonthlyToYearly =
      activeSubscriptionInfo.interval === SubscriptionPlanInterval.Monthly &&
      newSubscriptionInfo.interval === SubscriptionPlanInterval.Yearly;

    if (!isSameInterval && !isMonthlyToYearly) {
      throw new BadRequestError('Changing from Annual plan to Monthly plan is not allowed');
    }

    if (isSameTier) {
      // Swaps the priceId immediately with no proration - remaining days are not refunded.
      const updatedSubscription = await stripe.subscriptions.update(activeStripeSubscriptionId, {
        items: [
          {
            id: currentStripeSubscription.items.data[0].id,
            price: priceId,
          },
        ],
        proration_behavior: 'none',
      });

      return res.json({ subscriptionId: updatedSubscription.id, priceId });
    }

    // Different tier from here on
    const isUpgrade = activeSubscriptionInfo.tier < newSubscriptionInfo.tier;
    if (!isUpgrade) {
      throw new BadRequestError('Downgrading subscription is not allowed');
    }

    const updatedSubscription = await stripe.subscriptions.update(activeStripeSubscriptionId, {
      items: [
        {
          id: currentStripeSubscription.items.data[0].id,
          price: priceId,
        },
      ],
      proration_behavior: isMonthlyToYearly ? 'none' : 'create_prorations',
      billing_cycle_anchor: 'now',
    });

    return res.json({ subscriptionId: updatedSubscription.id, priceId });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
