import type Stripe from 'stripe';
import { CreditTransaction, mongoose } from '@bike4mind/database';
import { getStripe, isStripeConfigured } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { isCompSubscription, type AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionDetail';
import {
  invoicePaymentKey,
  type AdminStripeInvoice,
  type AdminStripePaymentMethod,
  type AdminSubscriptionStripe,
} from '@client/app/utils/adminSubscriptionStripe';

const READ_MAX_TIME_MS = 10_000;
const INVOICE_PAGE_SIZE = 100;
/** Invoices read per subscription (about 25 years monthly); past it the result is flagged truncated. */
export const MAX_INVOICES = 300;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

type CachedStripe = Extract<AdminSubscriptionStripe, { kind: 'stripe' }>;
const cache = new Map<string, { at: number; value: CachedStripe }>();

const remember = (id: string, value: CachedStripe) => {
  cache.delete(id);
  cache.set(id, { at: Date.now(), value });
  // Map iterates in insertion order, so the first key is the oldest.
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
};

/** Test hook: the cache is per process. */
export const clearAdminSubscriptionStripeCache = () => cache.clear();

type OwnedSubscription = {
  ownerType: 'User' | 'Organization';
  ownerId: string;
  subscriptionId: string;
  // Absent on rows from before the field existed; the list maps those to 'stripe' too.
  source?: AdminSubscriptionRow['source'];
};

const isResourceMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'resource_missing';

const toCard = (method: Stripe.PaymentMethod | string | null | undefined): AdminStripePaymentMethod | null => {
  if (!method || typeof method === 'string') return null;
  return {
    type: method.type,
    brand: method.card?.brand ?? null,
    last4: method.card?.last4 ?? null,
    expMonth: method.card?.exp_month ?? null,
    expYear: method.card?.exp_year ?? null,
  };
};

// The subscription's own default wins; else the customer's invoice default.
const paymentMethodOf = (subscription: Stripe.Subscription): AdminStripePaymentMethod | null => {
  const customer =
    typeof subscription.customer === 'string' || subscription.customer.deleted ? null : subscription.customer;
  return toCard(subscription.default_payment_method) ?? toCard(customer?.invoice_settings?.default_payment_method);
};

const iso = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

const listInvoices = async (stripe: Stripe, subscriptionId: string) => {
  const invoices: Stripe.Invoice[] = [];
  let truncated = false;
  for await (const invoice of stripe.invoices.list({
    subscription: subscriptionId,
    limit: INVOICE_PAGE_SIZE,
    expand: ['data.payments'],
  })) {
    if (invoices.length === MAX_INVOICES) {
      truncated = true;
      break;
    }
    invoices.push(invoice);
  }
  return { invoices, truncated };
};

// A preview persists nothing at Stripe. Canceled or ending subscriptions have no next invoice, and a failed
// preview must not take the invoices down with it.
const upcomingOf = async (stripe: Stripe, subscription: Stripe.Subscription): Promise<CachedStripe['upcoming']> => {
  const periodEnd = subscription.items.data[0]?.current_period_end;
  if (!periodEnd) return null;
  // A cancel_at beyond this period still renews first.
  const endsThisPeriod = subscription.cancel_at != null && subscription.cancel_at <= periodEnd;
  if (subscription.status === 'canceled' || subscription.cancel_at_period_end || endsThisPeriod) return null;
  const at = iso(periodEnd);
  if (!at) return null;
  try {
    const preview = await stripe.invoices.createPreview({ subscription: subscription.id });
    return { amount: preview.amount_due, currency: preview.currency, at };
  } catch {
    return null;
  }
};

const creditsByKey = async (doc: OwnedSubscription, keys: string[]): Promise<Map<string, number>> => {
  if (keys.length === 0) return new Map();
  const rows = await CreditTransaction.find({
    ownerId: doc.ownerId,
    ownerType: doc.ownerType,
    type: 'subscription',
    stripePaymentIntentId: { $in: keys },
  })
    .select('credits stripePaymentIntentId')
    .maxTimeMS(READ_MAX_TIME_MS)
    .lean<{ credits: number; stripePaymentIntentId: string }[]>();
  const credits = new Map<string, number>();
  for (const row of rows) {
    credits.set(row.stripePaymentIntentId, (credits.get(row.stripePaymentIntentId) ?? 0) + row.credits);
  }
  return credits;
};

const lifetimePaidOf = (invoices: Stripe.Invoice[]): CachedStripe['lifetimePaid'] => {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.status === 'paid')
      totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0) + invoice.amount_paid);
  }
  return [...totals].map(([currency, amount]) => ({ amount, currency }));
};

/**
 * The live Stripe side of one subscription's detail page, read-only: payment method, invoices joined to the
 * credits the ledger granted, the next invoice and lifetime paid. Null when the id names no subscription.
 * Stripe errors other than an unknown subscription propagate to the route. A successful read is cached 60 s.
 */
export async function getAdminSubscriptionStripe(
  id: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<AdminSubscriptionStripe | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const doc = await Subscription.findById(id).maxTimeMS(READ_MAX_TIME_MS).lean<OwnedSubscription>();
  if (!doc) return null;
  if (isCompSubscription({ source: doc.source ?? 'stripe', subscriptionId: doc.subscriptionId }))
    return { stripeConfigured: true, kind: 'comp' };
  if (!isStripeConfigured()) return { stripeConfigured: false };

  const cached = cache.get(id);
  if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const stripe = getStripe();
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(doc.subscriptionId, {
      expand: ['default_payment_method', 'customer.invoice_settings.default_payment_method'],
    });
  } catch (error) {
    if (isResourceMissing(error)) return { stripeConfigured: true, kind: 'missing' };
    throw error;
  }

  const [{ invoices, truncated }, upcoming] = await Promise.all([
    listInvoices(stripe, doc.subscriptionId),
    upcomingOf(stripe, subscription),
  ]);
  const keys = invoices.flatMap(invoice => [invoicePaymentKey(invoice), invoice.id]);
  const credits = await creditsByKey(doc, [...new Set(keys)]);

  const rows: AdminStripeInvoice[] = invoices.map(invoice => ({
    id: invoice.id,
    number: invoice.number,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    status: invoice.status,
    paidAt: iso(invoice.status_transitions?.paid_at),
    attempts: invoice.attempt_count,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    creditsGranted: credits.get(invoicePaymentKey(invoice)) ?? credits.get(invoice.id) ?? null,
  }));

  const value: CachedStripe = {
    stripeConfigured: true,
    kind: 'stripe',
    fetchedAt: new Date().toISOString(),
    paymentMethod: paymentMethodOf(subscription),
    invoices: rows,
    invoicesTruncated: truncated,
    lifetimePaid: lifetimePaidOf(invoices),
    upcoming,
  };
  remember(id, value);
  return value;
}
