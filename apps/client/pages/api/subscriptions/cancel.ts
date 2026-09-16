import { BadRequestError } from '@bike4mind/utils';
import { SubscriptionSource } from '@client/lib/subscriptions/types';
import { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { voidOpenSubscriptionInvoices } from '@server/integrations/stripe/dunning';
import { stripe } from '@server/integrations/stripe/stripe';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { subscriptionRepository } from '@server/models/Subscription';
import { resolveSubscriptionSource } from '@server/services/organizationService';
import { z } from 'zod';

const CancelSubscriptionSchema = z.object({
  priceId: z.string(),
});

// Stripe statuses where the current period is not paid for. Cancelling at period
// end would only buy the delinquent customer more dunning email for access they
// have not paid for, so these are cancelled outright.
const DELINQUENT_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);

const handler = baseApi()
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

    // Admin grants carry a synthetic `admin_granted_*` id that Stripe has never
    // heard of. Rejecting here keeps the caller's 400 truthful instead of sending
    // the sentinel to Stripe and getting a 500 back.
    const subscriptionId = userSubscription.subscriptionId;
    if (resolveSubscriptionSource(userSubscription) !== SubscriptionSource.Stripe || !subscriptionId) {
      throw new BadRequestError('This subscription is not managed by Stripe and cannot be canceled here');
    }

    // Stripe owns the live status - the local row can lag a failed renewal. Pass no
    // params to cancel on purpose: invoice_now and prorate default to false, so it
    // cannot mint a new invoice that would itself start dunning.
    const live = await stripe.subscriptions.retrieve(subscriptionId);
    const subscription = DELINQUENT_STATUSES.has(live.status)
      ? await stripe.subscriptions.cancel(subscriptionId)
      : await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

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

    const result: Partial<IUserSubscription> = {
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      priceId,
    };

    return res.status(200).json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
