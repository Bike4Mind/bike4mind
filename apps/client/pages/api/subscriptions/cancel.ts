import { BadRequestError } from '@bike4mind/utils';
import {
  SubscriptionSource,
  TERMINAL_SUBSCRIPTION_STATUSES,
  isDelinquentSubscriptionStatus,
  resolveSubscriptionSource,
} from '@client/lib/subscriptions/types';
import { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { voidOpenSubscriptionInvoices } from '@server/integrations/stripe/dunning';
import { stripe } from '@server/integrations/stripe/stripe';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { subscriptionRepository } from '@server/models/Subscription';
import Stripe from 'stripe';
import { z } from 'zod';

const CancelSubscriptionSchema = z.object({
  priceId: z.string(),
});

/**
 * Ask Stripe to stop billing `subscriptionId`.
 *
 * Deliberately parameterless: invoice_now and prorate both default to false, so
 * the cancel cannot mint a new invoice that would itself start dunning.
 */
async function cancelAtStripe(subscriptionId: string): Promise<Stripe.Subscription> {
  try {
    const live = await stripe.subscriptions.retrieve(subscriptionId);

    // Stripe already terminated it. There is nothing left to cancel, and Stripe
    // rejects updates on a terminal subscription - so treat the user's intent as
    // already satisfied rather than turning it into an error.
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(live.status)) return live;

    // Stripe owns the live status; the local row can lag a failed renewal.
    return isDelinquentSubscriptionStatus(live.status)
      ? await stripe.subscriptions.cancel(subscriptionId)
      : await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  } catch (error) {
    // StripeError exposes `statusCode`, not `status`, so the shared error handler
    // cannot map it and reports a 500 - which trips the LiveOps alarm for what is
    // a user-facing rejection. Only a real rejection is remapped: an auth, rate
    // limit or Stripe-side fault keeps its 5xx so it still alarms.
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      throw new BadRequestError(`Stripe rejected the cancellation: ${error.message}`);
    }
    throw error;
  }
}

// jwtOnly: this route can irreversibly cancel a subscription and void its
// invoices, and ApiKeyScope has no billing scope to gate a key on - so no API
// key reaches it. Browser JWT callers are unaffected.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStripeWebhook())
  .post(async (req, res) => {
    const user = req.user;
    const { priceId } = CancelSubscriptionSchema.parse(req.body);

    if (!user?.stripeCustomerId) {
      throw new BadRequestError('User does not have a recurring subscription');
    }

    const userSubscription = await subscriptionRepository.findCancelableUserSubscriptionByPriceId(priceId, user.id);
    if (!userSubscription) {
      throw new BadRequestError('User does not have an active subscription to cancel');
    }

    // The guard is source-based: `resolveSubscriptionSource` only falls back to
    // Stripe for rows that predate the `source` field. A current admin grant writes
    // `source: 'admin_grant'` with a synthetic `admin_grant_<uuid>` subscriptionId
    // Stripe has never heard of, so rejecting here keeps the caller's 400 truthful
    // instead of sending that sentinel to Stripe and getting a 500 back.
    const subscriptionId = userSubscription.subscriptionId;
    if (resolveSubscriptionSource(userSubscription) !== SubscriptionSource.Stripe || !subscriptionId) {
      throw new BadRequestError('This subscription is not managed by Stripe and cannot be canceled here');
    }

    const subscription = await cancelAtStripe(subscriptionId);

    // Closing the subscription does not close an invoice that is already open, and
    // an open invoice keeps Stripe's dunning retries (and emails) running. Cleanup
    // must never fail the request: the cancellation has already happened at Stripe,
    // so a 5xx would tell the user nothing happened when the opposite is true.
    try {
      const { voided, failed } = await voidOpenSubscriptionInvoices(subscriptionId);
      if (voided.length)
        req.logger.info(`Voided open invoices on cancelled subscription ${subscriptionId}`, { voided });
      if (failed.length) {
        req.logger.error(`Failed to void some open invoices on cancelled subscription ${subscriptionId}`, { failed });
      }
    } catch (error) {
      req.logger.error(`Failed to list open invoices on cancelled subscription ${subscriptionId}`, { error });
    }

    // `status` is Stripe's, not the lagging local row's: the client patches it into
    // its cache so an immediate cancel stops showing as a live plan right away.
    // `subscriptionId` is what the client matches the cached row on - `priceId` is
    // not unique per user, so two rows at one price would both get patched.
    const result: Partial<IUserSubscription> = {
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      priceId,
      subscriptionId,
      status: subscription.status,
    };

    return res.status(200).json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
