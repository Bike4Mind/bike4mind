import { BadRequestError } from '@bike4mind/utils';
import { SubscriptionSource, resolveSubscriptionSource } from '@client/lib/subscriptions/types';
import { subscriptionPlanSchema } from '@client/lib/userSubscriptions/schemas';
import { SubscriptionPlanInterval } from '@client/lib/userSubscriptions/types';
import { getSubscriptionPlanByPriceId } from '@client/lib/userSubscriptions/utils';
import { rethrowStripeRejection } from '@server/integrations/stripe/errors';
import { stripe } from '@server/integrations/stripe/stripe';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { subscriptionRepository } from '@server/models/Subscription';
import { Request } from 'express';
import { z } from 'zod';

type RequestBody = z.infer<typeof subscriptionPlanSchema>;

/**
 * Run one Stripe call, remapping a rejection to a 400. The route mutates a live
 * subscription, so a Stripe rejection is the caller's error to see - not a 500
 * that trips the LiveOps alarm.
 */
async function callStripe<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    rethrowStripeRejection(error, 'Stripe rejected the subscription change');
  }
}

// jwtOnly: this route mutates a live Stripe subscription, and ApiKeyScope has no
// billing scope to gate a key on - so no API key reaches it. Browser JWT callers
// are unaffected.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStripeWebhook())
  .put<Request<unknown, unknown, RequestBody>>(async (req, res) => {
    const userId = req.user?.id;
    const { priceId } = subscriptionPlanSchema.parse(req.body);

    const userSubscription = await subscriptionRepository.findChangeableUserSubscription(userId);
    if (!userSubscription) {
      throw new BadRequestError('User does not have an active subscription');
    }

    if (userSubscription.priceId === priceId) {
      throw new BadRequestError('User is already subscribed to this plan');
    }

    // Source-based guard, not a missing-sentinel one: a current admin grant writes
    // `source: 'admin_grant'` with a synthetic `admin_grant_<uuid>` subscriptionId
    // Stripe has never heard of, so rejecting here keeps the caller's 400 truthful
    // instead of sending that sentinel to Stripe. `resolveSubscriptionSource` only
    // falls back to Stripe for rows that predate the `source` field.
    const subscriptionId = userSubscription.subscriptionId;
    if (resolveSubscriptionSource(userSubscription) !== SubscriptionSource.Stripe || !subscriptionId) {
      throw new BadRequestError('This subscription is not managed by Stripe and cannot be changed here');
    }

    const currentSubscriptionInfo = getSubscriptionPlanByPriceId(userSubscription.priceId);
    const newSubscriptionInfo = getSubscriptionPlanByPriceId(priceId);
    if (!currentSubscriptionInfo || !newSubscriptionInfo) {
      throw new BadRequestError('Invalid subscription plan');
    }

    // Tier comparison only makes sense within the B4M plan ladder. A plan with no
    // tier (e.g. a standalone, single-tier product) isn't on that ladder - reject
    // rather than letting two same-tier plans from different products silently swap.
    if (currentSubscriptionInfo.tier === undefined || newSubscriptionInfo.tier === undefined) {
      throw new BadRequestError('This plan cannot be changed here');
    }

    const currentStripeSubscription = await callStripe(() => stripe.subscriptions.retrieve(subscriptionId));

    const isSameTier = currentSubscriptionInfo.tier === newSubscriptionInfo.tier;
    const isSameInterval = currentSubscriptionInfo.interval === newSubscriptionInfo.interval;
    const isMonthlyToYearly =
      currentSubscriptionInfo.interval === SubscriptionPlanInterval.Monthly &&
      newSubscriptionInfo.interval === SubscriptionPlanInterval.Yearly;

    if (!isSameInterval && !isMonthlyToYearly) {
      throw new BadRequestError('Changing from Annual plan to Monthly plan is not allowed');
    }

    if (isSameTier) {
      // Swaps the priceId immediately with no proration - remaining days are not refunded.
      const updatedSubscription = await callStripe(() =>
        stripe.subscriptions.update(subscriptionId, {
          items: [
            {
              id: currentStripeSubscription.items.data[0].id,
              price: priceId,
            },
          ],
          proration_behavior: 'none',
        })
      );

      return res.json({ subscriptionId: updatedSubscription.id, priceId });
    }

    // Different tier from here on
    const isUpgrade = currentSubscriptionInfo.tier < newSubscriptionInfo.tier;
    if (!isUpgrade) {
      throw new BadRequestError('Downgrading subscription is not allowed');
    }

    const updatedSubscription = await callStripe(() =>
      stripe.subscriptions.update(subscriptionId, {
        items: [
          {
            id: currentStripeSubscription.items.data[0].id,
            price: priceId,
          },
        ],
        proration_behavior: isMonthlyToYearly ? 'none' : 'create_prorations',
        billing_cycle_anchor: 'now',
      })
    );

    return res.json({ subscriptionId: updatedSubscription.id, priceId });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
