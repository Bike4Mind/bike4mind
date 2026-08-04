import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { stripe } from '@server/integrations/stripe/stripe';
import { Request } from 'express';
import Stripe from 'stripe';

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
 * Only the analytics-relevant scalars are returned - never the Stripe object.
 * That keeps customer/payment-method/invoice detail out of a browser response
 * whose only job is to populate an ad-platform event.
 */

/** Stripe reports minor units (cents); GA4 and the ad pixels want major units. */
const MINOR_UNITS_PER_MAJOR = 100;

const handler = baseApi().get<Request>(async (req, res) => {
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
  const ownerUserId = subscription && typeof subscription !== 'string' ? subscription.metadata?.userId : undefined;
  if (!ownerUserId || ownerUserId !== req.user.id) {
    throw new NotFoundError('Checkout session not found');
  }

  // Never report money that did not move. An incomplete or unpaid session must
  // not become a `purchase` in GA4 or a `Purchase` in the ad platforms.
  if (session.status !== 'complete' || session.payment_status === 'unpaid') {
    throw new BadRequestError('Checkout session is not a completed payment');
  }

  const lineItem = session.line_items?.data?.[0];
  const price = lineItem?.price;

  return res.json({
    // The session id, not the subscription id: it is unique per checkout, so a
    // customer who cancels and resubscribes reports two distinct purchases,
    // while a reload of the same success page reports one (GA4 dedupes on it).
    transactionId: session.id,
    value: (session.amount_total ?? 0) / MINOR_UNITS_PER_MAJOR,
    currency: (session.currency ?? 'usd').toUpperCase(),
    priceId: typeof price === 'object' && price ? price.id : undefined,
    planName: lineItem?.description ?? undefined,
    quantity: lineItem?.quantity ?? 1,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
