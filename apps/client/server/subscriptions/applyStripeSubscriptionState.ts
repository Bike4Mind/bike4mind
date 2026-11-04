import { organizationRepository } from '@bike4mind/database';
import {
  stripeSubscriptionRowFields,
  type StripeSubscriptionRowSource,
} from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import { type ISubscription, SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { setSeats } from '@server/services/organizationService';

export interface ApplyStripeSubscriptionStateResult {
  /** The row this write replaced, or null when this stage has no row for the subscription. */
  before: ISubscription | null;
  /** What the write set on the row; the same projection the reconciliation compares against. */
  after: ReturnType<typeof stripeSubscriptionRowFields>;
  /** Set for an organization-owned subscription whose organization was found. */
  seats?: { organizationId: string; before: number; after: number };
}

/**
 * The Stripe-wins write: the row and, for an organization-owned subscription, the organization's
 * seat count both take Stripe's values. Shared by the customer.subscription.updated worker and
 * Sync from Stripe. Call it inside `withTransaction`; it makes no Stripe call.
 */
export async function applyStripeSubscriptionState(
  subscription: StripeSubscriptionRowSource & { id: string; customer: string | { id: string } },
  { ownerType, logger }: { ownerType: SubscriptionOwnerType | undefined; logger: { warn: (message: string) => void } }
): Promise<ApplyStripeSubscriptionStateResult> {
  const after = stripeSubscriptionRowFields(subscription);
  const before = await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore(subscription.id, after);

  if (ownerType !== SubscriptionOwnerType.Organization) return { before, after };

  // Keep organization.seats and the active Subscription.quantity in sync with Stripe via the
  // shared setSeats service (validation included).
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const organization = await organizationRepository.findByStripeCustomerId(customerId);
  if (!organization) return { before, after };

  const seatsBefore = organization.seats;
  try {
    await setSeats(organization.id, after.quantity, { type: 'stripe' });
  } catch (err) {
    // Stripe is the source of truth for billed seat count. If our local validation (team-size
    // floor / platform min) would reject this value, we still must NOT drift from Stripe -
    // otherwise the customer is billed for a different number of seats than our DB reports.
    // Log loudly and force-write the seat count directly. The org-internal floor will re-apply
    // on the next manual change.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `setSeats validation failed for org ${organization.id} on Stripe webhook (quantity=${after.quantity}). Force-syncing to avoid drift. Reason: ${message}`
    );
    await organizationRepository.update({ id: organization.id, seats: after.quantity });
  }
  return { before, after, seats: { organizationId: organization.id, before: seatsBefore, after: after.quantity } };
}
