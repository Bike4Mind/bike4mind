import { organizationRepository } from '@bike4mind/database';
import { BadRequestError, ConflictError, HTTPError } from '@bike4mind/common';
import {
  SubscriptionOwnerType,
  SubscriptionSource,
  isDelinquentSubscriptionStatus,
  resolveSubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { baseApi } from '@server/middlewares/baseApi';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { subscriptionRepository } from '@server/models/Subscription';
import Stripe from 'stripe';
import { z } from 'zod';

const PayInvoiceSchema = z.object({
  subscriptionId: z.string().min(1),
});

export type PayInvoiceResult = { status: 'paid' } | { status: 'requires_action'; hostedInvoiceUrl: string };

const PAYMENT_REQUIRED = 402;
// One message for "no such row" and "not yours", so the id cannot be probed for existence.
const NOT_FOUND_MESSAGE = 'Subscription not found';
const NOT_PAYABLE_MESSAGE = 'There is no open invoice to pay. If you just paid, your plan will update shortly.';

const AUTH_REQUIRED_CODES = new Set(['invoice_payment_intent_requires_action', 'authentication_required']);

const needsAuthentication = (error: Stripe.errors.StripeError): boolean =>
  AUTH_REQUIRED_CODES.has(error.code ?? '') ||
  AUTH_REQUIRED_CODES.has(error.decline_code ?? '') ||
  error.payment_intent?.status === 'requires_action';

type PayableInvoice = Stripe.Invoice & { id: string };

const idOf = (ref: string | { id: string } | null): string | null =>
  typeof ref === 'string' ? ref : (ref?.id ?? null);

// jwtOnly: this route charges a card, and ApiKeyScope has no billing scope to gate a key on.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStripeWebhook())
  .use(rateLimit({ limit: 5, windowMs: 60 * 1000 }))
  .post(async (req, res) => {
    const user = req.user;
    const { subscriptionId } = PayInvoiceSchema.parse(req.body);

    const row = await subscriptionRepository.findByStripeSubscriptionId(subscriptionId);
    if (!row) throw new BadRequestError(NOT_FOUND_MESSAGE);

    let customerId: string | null;
    if (row.ownerType === SubscriptionOwnerType.Organization) {
      const organization = await organizationRepository.findById(row.ownerId);
      // Owner only, matching the billing portal and the payment-failed email recipient.
      if (!organization || organization.userId !== user.id) throw new BadRequestError(NOT_FOUND_MESSAGE);
      customerId = organization.stripeCustomerId ?? null;
    } else {
      if (row.ownerId !== user.id) throw new BadRequestError(NOT_FOUND_MESSAGE);
      customerId = user.stripeCustomerId ?? null;
    }

    if (resolveSubscriptionSource(row) !== SubscriptionSource.Stripe) {
      throw new BadRequestError('This subscription is not billed through Stripe');
    }
    if (!isDelinquentSubscriptionStatus(row.status)) throw new ConflictError(NOT_PAYABLE_MESSAGE);

    const live = await stripe.subscriptions.retrieve(subscriptionId);
    if (!customerId || idOf(live.customer) !== customerId) {
      req.logger.warn(`pay-invoice: customer mismatch on subscription ${subscriptionId}`);
      throw new BadRequestError(NOT_FOUND_MESSAGE);
    }

    // Not just latest_invoice: a subscription left delinquent across a renewal keeps the older failed
    // invoice open, and the newest one may still be a draft.
    const { data: openInvoices } = await stripe.invoices.list({
      subscription: subscriptionId,
      status: 'open',
      limit: 100,
    });
    const invoices = openInvoices
      .filter((invoice): invoice is PayableInvoice => Boolean(invoice.id))
      .sort((a, b) => a.created - b.created);
    if (invoices.length === 0) throw new ConflictError(NOT_PAYABLE_MESSAGE);

    const payOne = async (invoice: PayableInvoice): Promise<PayInvoiceResult> => {
      const requiresAction = (): PayInvoiceResult => {
        // A bearer link to the invoice: returned for this redirect only, never persisted.
        if (!invoice.hosted_invoice_url) throw new Error(`Open invoice ${invoice.id} has no hosted_invoice_url`);
        return { status: 'requires_action', hostedInvoiceUrl: invoice.hosted_invoice_url };
      };

      try {
        const paid = await stripe.invoices.pay(invoice.id);
        // Anything short of paid (e.g. a bank debit still processing) is left to the hosted page.
        return paid.status === 'paid' ? { status: 'paid' } : requiresAction();
      } catch (error) {
        if (!(error instanceof Stripe.errors.StripeError)) throw error;
        if (needsAuthentication(error)) return requiresAction();
        if (error instanceof Stripe.errors.StripeCardError) {
          throw new HTTPError(PAYMENT_REQUIRED, error.message || 'Your card was declined.');
        }
        // A second click racing the first: either the invoice is no longer open, or Stripe still holds
        // the first payment's lock on it (lock_timeout, raised as a rate-limit error).
        if (error instanceof Stripe.errors.StripeInvalidRequestError || error.code === 'lock_timeout') {
          req.logger.warn(`pay-invoice: Stripe refused paying ${invoice.id}`, { code: error.code });
          throw new ConflictError(NOT_PAYABLE_MESSAGE);
        }
        throw error;
      }
    };

    let result: PayInvoiceResult = { status: 'paid' };
    for (const invoice of invoices) {
      result = await payOne(invoice);
      if (result.status !== 'paid') break;
    }

    return res.status(200).json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
