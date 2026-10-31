import { organizationRepository, userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { isStripeConfigured, stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { voidOpenSubscriptionInvoices } from '@bike4mind/server-utils/integrations/stripe/dunning';
import { TERMINAL_SUBSCRIPTION_STATUSES } from '@bike4mind/server-utils/lib/subscriptions/types';

/**
 * Why an account's subscriptions are being ended. Stamped into Stripe's cancellation comment so
 * the dashboard says who cancelled and why.
 */
export type AccountSubscriptionCancelReason = 'suspended' | 'contained' | 'account_deleted';

const CANCELLATION_COMMENT: Record<AccountSubscriptionCancelReason, string> = {
  suspended: 'Canceled automatically: account suspended by an admin',
  contained: 'Canceled automatically: account contained by an admin bulk action',
  account_deleted: 'Canceled automatically: account deleted',
};

export type SubscriptionCancelFailure = { customerId: string; subscriptionId: string | null; reason: string };

export type AccountSubscriptionCancellation = {
  /** Stripe subscription ids canceled by this call. Stripe cannot reinstate them. */
  canceled: string[];
  failed: SubscriptionCancelFailure[];
};

export const NO_SUBSCRIPTIONS_CANCELED: AccountSubscriptionCancellation = { canceled: [], failed: [] };

const AUDIT_CONTEXT: Record<AccountSubscriptionCancelReason, string> = {
  suspended: 'on suspending the account',
  contained: 'on containing the account',
  account_deleted: 'before deleting the account',
};

/**
 * The best-effort admin audit entry for a cancellation, or null when there was nothing to cancel.
 * Spread it into recordAdminAction* with the caller's target and reason.
 */
export function subscriptionCancellationAudit(
  result: AccountSubscriptionCancellation,
  reason: AccountSubscriptionCancelReason
): { action: 'user.subscriptions.canceled'; summary: string; details: Record<string, unknown> } | null {
  if (result.canceled.length === 0 && result.failed.length === 0) return null;
  const failed = result.failed.length > 0 ? `; ${result.failed.length} could not be canceled` : '';
  return {
    action: 'user.subscriptions.canceled',
    summary: `canceled ${result.canceled.length} Stripe subscription(s) ${AUDIT_CONTEXT[reason]}${failed}`,
    details: { canceledSubscriptions: result.canceled, failedSubscriptions: result.failed },
  };
}

const reasonOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * The Stripe customers whose subscriptions bill this account: its own, and those of the
 * organizations it owns. A member's org is not included; only the billing owner pays for it.
 */
async function billedCustomerIds(user: { id: string; stripeCustomerId?: string | null }): Promise<string[]> {
  const ownedOrgs = await organizationRepository.find({ userId: user.id });
  const ids = [user.stripeCustomerId, ...ownedOrgs.map(org => org.stripeCustomerId)];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

async function cancelCustomerSubscriptions(
  customerId: string,
  comment: string,
  result: AccountSubscriptionCancellation
): Promise<void> {
  // Stripe, not the local rows, is read: a row can lag a renewal, and a deleted account's rows are
  // the very ones that went unnoticed. One page, like voidOpenSubscriptionInvoices: a customer with
  // over 100 live subscriptions is not a real case.
  const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  for (const subscription of page.data) {
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) continue;
    try {
      // prorate: false and no invoice_now, so the cancel mints no credit note or invoice; refunds
      // stay an admin decision. customer.subscription.deleted then closes the local row.
      await stripe.subscriptions.cancel(subscription.id, { prorate: false, cancellation_details: { comment } });
      result.canceled.push(subscription.id);
    } catch (error) {
      result.failed.push({ customerId, subscriptionId: subscription.id, reason: reasonOf(error) });
      continue;
    }
    // An open invoice keeps Stripe's dunning retries running after the cancel. Best-effort: the
    // subscription is already canceled, which is what this call is for.
    try {
      await voidOpenSubscriptionInvoices(subscription.id);
    } catch {
      // Dunning on a canceled subscription is noise, not a renewal; nothing to report.
    }
  }
}

/**
 * Immediately cancels every live Stripe subscription that bills this account (its own customer
 * and the organizations it owns), so a suspended or deleted account never renews. Never throws:
 * the suspension or deletion it accompanies must go ahead, so each failure is logged at error and
 * returned for the caller's response and audit record. Refunds are deliberately not issued.
 *
 * Call it before a hard delete: the customer ids are read from the user and its owned orgs.
 */
export async function cancelAccountSubscriptions(
  input: { userId: string; reason: AccountSubscriptionCancelReason },
  logger: Pick<Logger, 'info' | 'error'>
): Promise<AccountSubscriptionCancellation> {
  const result: AccountSubscriptionCancellation = { canceled: [], failed: [] };
  if (!isStripeConfigured()) return result;

  let customerIds: string[];
  try {
    const user = await userRepository.findById(input.userId);
    if (!user) return result;
    customerIds = await billedCustomerIds(user);
  } catch (error) {
    result.failed.push({ customerId: 'unknown', subscriptionId: null, reason: reasonOf(error) });
    logger.error('[Billing] could not resolve the subscriptions to cancel for an account', {
      userId: input.userId,
      reason: input.reason,
      error: reasonOf(error),
    });
    return result;
  }

  const comment = CANCELLATION_COMMENT[input.reason];
  for (const customerId of customerIds) {
    try {
      await cancelCustomerSubscriptions(customerId, comment, result);
    } catch (error) {
      result.failed.push({ customerId, subscriptionId: null, reason: reasonOf(error) });
    }
  }

  if (result.failed.length > 0) {
    logger.error('[Billing] failed to cancel subscriptions for an account', {
      userId: input.userId,
      reason: input.reason,
      canceled: result.canceled,
      failed: result.failed,
    });
  } else if (result.canceled.length > 0) {
    logger.info('[Billing] canceled subscriptions for an account', {
      userId: input.userId,
      reason: input.reason,
      canceled: result.canceled,
    });
  }
  return result;
}
