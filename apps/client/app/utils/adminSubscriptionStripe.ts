import { z } from 'zod';

/**
 * Response of GET /api/admin/subscriptions/[id]/stripe: the live Stripe side of the detail page. Pure and
 * React-free, because the server reader imports it too. See docs/admin-subscriptions-spec.md sections 5.2, 5.6.
 */

export const AdminSubscriptionStripeParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i),
  fresh: z
    .enum(['1', 'true'])
    .optional()
    .transform(value => value !== undefined),
});

export type AdminStripePaymentMethod = {
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

export type AdminStripeInvoice = {
  id: string;
  number: string | null;
  createdAt: string;
  /** Minor units, as are all amounts here. */
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string | null;
  paidAt: string | null;
  attempts: number;
  hostedInvoiceUrl: string | null;
  /** Credits the ledger granted for this invoice; null when none was found. */
  creditsGranted: number | null;
};

export type AdminSubscriptionStripe =
  | { stripeConfigured: false }
  /** An admin grant: nothing exists at Stripe. */
  | { stripeConfigured: true; kind: 'comp' }
  /** Stripe does not know this subscription id. */
  | { stripeConfigured: true; kind: 'missing' }
  | {
      stripeConfigured: true;
      kind: 'stripe';
      fetchedAt: string;
      paymentMethod: AdminStripePaymentMethod | null;
      /** Newest first. */
      invoices: AdminStripeInvoice[];
      /** The invoice page cap was hit, so `invoices` and `lifetimePaid` cover only the latest ones. */
      invoicesTruncated: boolean;
      /** Sum of `amountPaid` over paid invoices, per currency. Refunds are not subtracted. */
      lifetimePaid: { amount: number; currency: string }[];
      upcoming: { amount: number; currency: string; at: string } | null;
    };

type PaymentRef = { payments?: { data: { payment?: { type?: string; payment_intent?: string | { id: string } | null } }[] } };

/**
 * The id the ledger stores as `stripePaymentIntentId` for an invoice's grant: the payment intent, else the
 * invoice id (non-card payments). Must stay in sync with apps/workers/src/lib/userSubscriptions/serverUtils.ts.
 */
export const invoicePaymentKey = (invoice: PaymentRef & { id: string }): string => {
  const payment = invoice.payments?.data[0]?.payment;
  if (payment?.type !== 'payment_intent') return invoice.id;
  const intent = typeof payment.payment_intent === 'string' ? payment.payment_intent : payment.payment_intent?.id;
  return intent || invoice.id;
};

const EXPIRY_WARNING_DAYS = 30;

/** True when the card is still valid but expires (end of its expiry month) within `days`. */
export const cardExpiresWithinDays = (
  paymentMethod: Pick<AdminStripePaymentMethod, 'expMonth' | 'expYear'> | null,
  now: number,
  days = EXPIRY_WARNING_DAYS
): boolean => {
  if (!paymentMethod?.expMonth || !paymentMethod.expYear) return false;
  // A card works through the last day of its expiry month; month index expMonth is the first of the next one.
  const expiresAt = Date.UTC(paymentMethod.expYear, paymentMethod.expMonth, 1);
  return expiresAt > now && expiresAt - now <= days * 86_400_000;
};
