import { Organization, User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type Stripe from 'stripe';
import { isStripeConfigured, stripe } from '../integrations/stripe/stripe';
import { cancelAccountSubscriptions } from './cancelAccountSubscriptions';

export type StripeCustomerRedaction =
  | { outcome: 'redacted'; customerId: string }
  | { outcome: 'noCustomer' | 'notConfigured' | 'alreadyDeleted' | 'skippedShared' };

// Structural keys the app reads back; every other metadata key may carry personal data.
const KEPT_METADATA_KEYS = new Set(['type', 'stage']);
const ORGANIZATION_CUSTOMER_TYPE = 'Organization';

// ms per Stripe request; mirrors STRIPE_REQUEST_TIMEOUT_MS in cancelAccountSubscriptions.ts.
const options = { timeout: 10_000 };

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'resource_missing';

/**
 * Removes the personal data from the user's own Stripe customer for an account erasure: cancel first,
 * then blank name, email, phone, address, shipping, description and free-form metadata, detach every
 * payment method and delete tax IDs. The customer is kept, not deleted, so invoices, disputes and
 * admin lookups keyed on its ID still resolve during the financial-record retention period; Stripe
 * snapshots the billing details onto each finalized invoice, so those are untouched.
 *
 * Skips a customer that another user or any organization (soft-deleted included) also points at, or
 * that is typed as an organization's. Throws when a subscription cannot be canceled or a Stripe write
 * fails, so the purge retries; every write sets a final state, so a re-run is safe.
 */
export async function redactAccountStripeCustomer(
  userId: string,
  { logger, assertLease }: { logger: Pick<Logger, 'info' | 'warn' | 'error'>; assertLease: () => Promise<void> }
): Promise<StripeCustomerRedaction> {
  if (!isStripeConfigured()) return { outcome: 'notConfigured' };
  const user = await User.findById(userId).select({ stripeCustomerId: 1 }).lean<{ stripeCustomerId?: string | null }>();
  const customerId = user?.stripeCustomerId;
  if (!customerId) return { outcome: 'noCustomer' };

  const [org, otherUser] = await Promise.all([
    Organization.exists({ stripeCustomerId: customerId }).setOptions({ includeDeleted: true }),
    User.exists({ stripeCustomerId: customerId, _id: { $ne: userId } }),
  ]);
  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripe.customers.retrieve(customerId, {}, options);
  } catch (error) {
    if (isMissing(error)) return { outcome: 'alreadyDeleted' };
    throw error;
  }
  if (customer.deleted) return { outcome: 'alreadyDeleted' };
  if (org || otherUser || customer.metadata?.type === ORGANIZATION_CUSTOMER_TYPE) {
    logger.warn('[AccountDeletion] kept a Stripe customer that is not solely the deleted user', { userId, customerId });
    return { outcome: 'skippedShared' };
  }

  await assertLease();
  const canceled = await cancelAccountSubscriptions(
    { userId, reason: 'account_deleted', customerIds: [customerId], beforeWrite: assertLease },
    logger
  );
  if (canceled.failed.length > 0) {
    throw new Error(
      `Stripe customer ${customerId} not redacted: ${canceled.failed.length} subscription(s) not canceled`
    );
  }

  const metadata: Record<string, string> = { erased: 'true' };
  for (const key of Object.keys(customer.metadata ?? {})) {
    if (!KEPT_METADATA_KEYS.has(key) && key !== 'erased') metadata[key] = '';
  }
  await assertLease();
  // '' unsets a Stripe field; null is not accepted for strings.
  await stripe.customers.update(
    customerId,
    { name: '', email: '', phone: '', description: '', address: '', shipping: '', metadata },
    options
  );

  // Detach and delete page by page: each write shrinks the list, so re-listing from the start is safe
  // and no cursor is needed.
  for (let more = true; more;) {
    const methods = await stripe.customers.listPaymentMethods(customerId, { limit: 100 }, options);
    for (const method of methods.data) {
      await assertLease();
      await stripe.paymentMethods.detach(method.id, {}, options);
    }
    more = methods.has_more && methods.data.length > 0;
  }
  for (let more = true; more;) {
    const taxIds = await stripe.customers.listTaxIds(customerId, { limit: 100 }, options);
    for (const taxId of taxIds.data) {
      await assertLease();
      await stripe.customers.deleteTaxId(customerId, taxId.id, {}, options);
    }
    more = taxIds.has_more && taxIds.data.length > 0;
  }

  logger.info('[AccountDeletion] redacted the Stripe customer', { userId, customerId });
  return { outcome: 'redacted', customerId };
}
