import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { minorUnitsPerMajor } from '@server/integrations/stripe/currency';
import { Request } from 'express';
import Stripe from 'stripe';

/**
 * GET /api/stripe/payment-intent?id=pi_...
 *
 * The purchase facts for a completed credit purchase, so the client can report a
 * `purchase` conversion (see app/utils/purchaseConversion.ts) with a value Stripe
 * vouches for. The credit-purchase counterpart of api/subscriptions/checkout-session.ts:
 * credit packs are paid with the Payment Element, not Checkout, and Stripe returns the
 * customer to the app with the PaymentIntent id on the URL
 * (StripePaymentReturnHandler), which is all the browser can be trusted to supply.
 *
 * Only the analytics-relevant scalars are returned - never the Stripe object.
 */
// Browser only: the customer's own return from Stripe is the one caller, so an API key
// has no business here (jwtOnly).
const handler = baseApi({ auth: 'jwtOnly' })
  // A live Stripe read per request; same throttle as the checkout-session route.
  .use(
    rateLimit({
      limit: 30,
      windowMs: 60 * 1000,
    })
  )
  .get<Request>(async (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (!id || !id.startsWith('pi_')) {
      throw new BadRequestError('A Stripe payment intent id is required');
    }

    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.retrieve(id);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        throw new NotFoundError('Payment not found');
      }
      throw error;
    }

    // Authorization: start-payment stamps the purchasing user's id into the intent's
    // metadata. Anything not positively this caller's 404s, as for checkout sessions:
    // confirming that an id exists is itself a leak.
    if (!intent.metadata?.userId || intent.metadata.userId !== req.user.id) {
      throw new NotFoundError('Payment not found');
    }

    // Only a credit purchase: start-payment is the one path that creates intents with
    // a credit amount. Other intents (if any ever share the account) are not this
    // endpoint's to describe.
    const credits = Number(intent.metadata.credits);
    if (!Number.isFinite(credits) || credits <= 0) {
      throw new NotFoundError('Payment not found');
    }

    // Never report money that did not move: only a settled payment with an amount.
    // `processing` (bank debits) settles later, and is not reported from here.
    if (intent.status !== 'succeeded' || !(intent.amount_received > 0)) {
      throw new BadRequestError('Payment is not a completed payment');
    }

    const currency = intent.currency ?? 'usd';
    const packageId = intent.metadata.packageId;

    return res.json({
      // Unique per payment, so a reload of the return URL reports one purchase.
      transactionId: intent.id,
      value: intent.amount_received / minorUnitsPerMajor(currency),
      currency: currency.toUpperCase(),
      priceId: packageId ? `credits-${packageId}` : 'credits',
      planName: intent.description ?? undefined,
      quantity: 1,
      kind: 'credits',
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
