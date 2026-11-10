import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { Request } from 'express';
import Stripe from 'stripe';
import { minorUnitsPerMajor } from '@bike4mind/server-utils/integrations/stripe/currency';
import { planCreditsPerCycle } from '@bike4mind/server-utils/lib/userSubscriptions/planCreditsPerCycle';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

/**
 * GET /api/subscriptions/checkout-session?id=cs_...
 *
 * The purchase facts for a completed Stripe Checkout session, so the client can
 * report a `purchase` conversion (see app/utils/purchaseConversion.ts) with a
 * value Stripe vouches for.
 *
 * Why the round trip at all: Stripe's success_url can carry the session id but
 * not a trustworthy amount, and the app's own subscription row may not exist yet
 * (it is written by the webhook, which races the redirect). Reading the session
 * is both authoritative and available the instant the customer lands.
 *
 * Only the analytics-relevant scalars, plus the plan's credit allotment for the
 * customer's confirmation, are returned - never the Stripe object. That keeps
 * customer/payment-method/invoice detail out of the browser.
 */

const handler = baseApi()
  // A live Stripe read per request, and Stripe's read limits are account-wide, so
  // an abusive caller would degrade checkout for every customer. Matches the
  // throttle other third-party-fanout routes use.
  .use(
    rateLimit({
      limit: 30,
      windowMs: 60 * 1000,
    })
  )
  .get<Request>(async (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    // Cheap shape check before spending a Stripe call on obvious junk.
    if (!id || !id.startsWith('cs_')) {
      throw new BadRequestError('A Stripe checkout session id is required');
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(id, { expand: ['subscription', 'line_items'] });
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        throw new NotFoundError('Checkout session not found');
      }
      throw error;
    }

    // Authorization: both checkout paths stamp the purchasing user's id into
    // `subscription_data.metadata`, so the subscription's metadata is the link
    // back to a user. Checking that (rather than the session's customer) covers
    // organization purchases too, where the Stripe customer is the org.
    // Anything we cannot positively tie to this caller 404s - a session id is
    // guessable enough that confirming its existence is itself a leak.
    const subscription = session.subscription;
    const subscriptionMetadata = subscription && typeof subscription !== 'string' ? subscription.metadata : undefined;
    const ownerUserId = subscriptionMetadata?.userId;
    if (!ownerUserId || ownerUserId !== req.user.id) {
      throw new NotFoundError('Checkout session not found');
    }

    // Never report money that did not move. Allowlist, not denylist: Stripe's
    // payment_status union is `paid | unpaid | no_payment_required`, and the third
    // member is a $0 completion (a 100%-off coupon attached in the dashboard, or a
    // future trial). Rejecting only 'unpaid' would report those as revenue and train
    // ad bidding on non-revenue conversions - the exact failure this endpoint exists
    // to prevent - so anything that is not positively 'paid' fails closed.
    if (session.status !== 'complete' || session.payment_status !== 'paid') {
      throw new BadRequestError('Checkout session is not a completed payment');
    }

    const lineItem = session.line_items?.data?.[0];
    const price = lineItem?.price;
    const currency = session.currency ?? 'usd';
    const priceId = typeof price === 'object' && price ? price.id : undefined;
    const quantity = lineItem?.quantity ?? 1;
    // Display-only, so best-effort: a failed settings read must not cost the conversion report.
    const credits = await planCreditsPerCycle({
      ownerType:
        subscriptionMetadata?.ownerType === SubscriptionOwnerType.Organization
          ? SubscriptionOwnerType.Organization
          : SubscriptionOwnerType.User,
      priceId,
      quantity,
    }).catch(() => null);

    return res.json({
      // The session id, not the subscription id: it is unique per checkout, so a
      // customer who cancels and resubscribes reports two distinct purchases,
      // while a reload of the same success page reports one (GA4 dedupes on it).
      transactionId: session.id,
      value: (session.amount_total ?? 0) / minorUnitsPerMajor(currency),
      currency: currency.toUpperCase(),
      priceId,
      planName: lineItem?.description ?? undefined,
      quantity,
      credits: credits ?? undefined,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
