import { organizationRepository } from '@bike4mind/database';
import {
  SEAT_BILLING_STATUSES,
  stripeSubscriptionRowFields,
  type StripeSubscriptionRowSource,
} from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import { type ISubscription, SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';

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
  {
    ownerType,
    expectedUpdatedAt,
  }: {
    ownerType: SubscriptionOwnerType | undefined;
    /** Write only if the row still has this `updatedAt`; otherwise `before` is null and nothing is written. */
    expectedUpdatedAt?: Date;
  }
): Promise<ApplyStripeSubscriptionStateResult> {
  const after = stripeSubscriptionRowFields(subscription);
  const before = await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore(
    subscription.id,
    after,
    expectedUpdatedAt
  );
  if (!before && expectedUpdatedAt) return { before, after };

  if (ownerType !== SubscriptionOwnerType.Organization) return { before, after };

  // Only a billing subscription sets the seat count; same set the reconciliation compares with.
  if (!SEAT_BILLING_STATUSES.has(after.status)) return { before, after };

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const organization = await organizationRepository.findByStripeCustomerId(customerId);
  if (!organization) return { before, after };

  const seatsBefore = organization.seats;
  // Written directly, not through setSeats: that opens its own transaction, which does not nest inside
  // the caller's and deadlocks on the row written above. The row already carries Stripe's quantity, and
  // Stripe's count wins over the team-size floor setSeats would enforce.
  await organizationRepository.update({ id: organization.id, seats: after.quantity });
  return { before, after, seats: { organizationId: organization.id, before: seatsBefore, after: after.quantity } };
}
