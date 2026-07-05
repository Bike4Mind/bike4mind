import { organizationRepository, inviteRepository, withTransaction } from '@bike4mind/database';
import { IOrganizationDocument, IMongoDocument } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
} from '@client/lib/subscriptions/constants';
import { ISubscription, SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';

/**
 * Count outstanding org invites that haven't been accepted yet. Pending invites
 * consume a seat slot the moment they're accepted, so they must be counted
 * toward the seat-change floor - otherwise an admin can reduce seats below the
 * eventual team size and the next acceptance will fail or skew billing.
 */
export async function countPendingOrganizationInvites(orgId: string): Promise<number> {
  const invites = await inviteRepository.findAllByDocumentId(orgId);
  return invites.reduce((total, invite) => total + (invite.recipients?.pending?.length ?? 0), 0);
}

/**
 * Resolve `source` defensively for rows that may pre-date the source-field
 * migration. Mongoose schema defaults only fire on insert, not on read of
 * pre-existing documents, so a Subscription written before the schema change
 * comes back with `source === undefined`. Treat unknown legacy rows as Stripe-
 * managed (the historical default) UNLESS the row carries the synthetic
 * `admin_granted_*` subscriptionId pattern from the legacy grant endpoint.
 */
export function resolveSubscriptionSource(sub: Pick<ISubscription, 'source' | 'subscriptionId'>): SubscriptionSource {
  if (sub.source) return sub.source;
  if (sub.subscriptionId?.startsWith('admin_granted_')) return SubscriptionSource.AdminGrant;
  return SubscriptionSource.Stripe;
}

/**
 * Deterministically pick the single Subscription that should be mutated by a
 * seat update. Priority:
 *   1. The active Stripe-managed sub (the one being billed).
 *   2. The active admin_grant (will be flipped on conversion).
 * If neither is found, return null. Filtering is necessary because during the
 * conversion window an org can transiently have both an admin_grant AND a
 * Stripe sub active - without an ordering rule, `activeSubs[0]` would pick
 * arbitrarily and the wrong row would drift from Stripe.
 */
export function pickPrimarySubscription(
  activeSubs: (ISubscription & IMongoDocument)[]
): (ISubscription & IMongoDocument) | null {
  const stripeSub = activeSubs.find(
    s => resolveSubscriptionSource(s) === SubscriptionSource.Stripe && Boolean(s.subscriptionId)
  );
  if (stripeSub) return stripeSub;
  const adminGrant = activeSubs.find(s => resolveSubscriptionSource(s) === SubscriptionSource.AdminGrant);
  return adminGrant ?? null;
}

export type SeatChangeActor = { type: 'stripe' } | { type: 'admin'; userId: string };

const ADMIN_MIN_SEATS = 1;

/**
 * Throws if the requested seat count is invalid given the org's current state
 * and the actor performing the change.
 *
 *  - Stripe path: seats must be >= ORGANIZATION_SUBSCRIPTION_MIN_SEATS (the paid-plan minimum)
 *  - Admin path:  seats must be >= 1 (admin grants may be smaller than the paid minimum)
 *  - Both:        seats >= current team size (owner + members + pending invites),
 *                 and <= ORGANIZATION_SUBSCRIPTION_MAX_SEATS
 *
 * Pending invites count toward the floor because each one will consume a seat
 * the moment the recipient accepts. Letting an admin shrink below
 * `accepted + pending` causes the next acceptance to fail (org full) and may
 * skew billing on conversion.
 */
export function validateSeatChange(
  organization: Pick<IOrganizationDocument, 'users'>,
  newSeats: number,
  actor: SeatChangeActor,
  pendingInviteCount: number = 0
): void {
  // Owner + accepted members + outstanding invites.
  const currentTeamSize = organization.users.length + 1 + pendingInviteCount;
  const platformMin = actor.type === 'stripe' ? ORGANIZATION_SUBSCRIPTION_MIN_SEATS : ADMIN_MIN_SEATS;
  const minimumRequiredSeats = Math.max(platformMin, currentTeamSize);

  if (newSeats < minimumRequiredSeats) {
    const pendingNote =
      pendingInviteCount > 0
        ? ` including ${pendingInviteCount} pending invite${pendingInviteCount === 1 ? '' : 's'}`
        : '';
    throw new BadRequestError(
      `Cannot reduce seats below current team size. Minimum required seats: ${minimumRequiredSeats} (${currentTeamSize} team members${pendingNote})`
    );
  }
  if (newSeats > ORGANIZATION_SUBSCRIPTION_MAX_SEATS) {
    throw new BadRequestError(`Seats cannot exceed ${ORGANIZATION_SUBSCRIPTION_MAX_SEATS}`);
  }
}

/**
 * Validate and persist a new seat count for an organization.
 *
 * Callers:
 *  - Stripe webhook (`customer.subscription.updated`) - actor: 'stripe', after Stripe has already accepted the quantity change
 *  - Admin endpoint (`PATCH /api/admin/organizations/[id]/seats`) - actor: 'admin'
 *
 * Writes:
 *  - organizations.seats
 *  - subscriptions.quantity (active subscription for the org, if one exists)
 */
export async function setSeats(orgId: string, newSeats: number, actor: SeatChangeActor) {
  // Wrap the org + subscription writes in a single transaction so a failure
  // on the subscription update rolls back the org seat change. Nested calls
  // (e.g. from the Stripe webhook handler, which already opens its own
  // transaction) reuse the ambient session via the mongoose driver.
  return withTransaction(async () => {
    const organization = await organizationRepository.findById(orgId);
    if (!organization) throw new NotFoundError('Organization not found');

    const pendingInviteCount = await countPendingOrganizationInvites(organization.id);
    validateSeatChange(organization, newSeats, actor, pendingInviteCount);

    organization.seats = newSeats;
    await organizationRepository.update(organization);

    const activeSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      organization.id
    );
    const activeSub = pickPrimarySubscription(activeSubs);
    if (activeSub) {
      if (activeSub.subscriptionId) {
        // Post-migration every admin_grant row also carries a subscriptionId
        // (the `admin_grant_<uuid>` sentinel), so this branch handles both
        // Stripe-managed and admin_grant subs. The repository method name is
        // historical - internally it's `findOneAndUpdate({ subscriptionId })`.
        await subscriptionRepository.updateByStripeSubscriptionId(activeSub.subscriptionId, {
          quantity: newSeats,
        });
      } else {
        // Defensive fallback for legacy rows that pre-date the sentinel-id
        // migration. Should be unreachable on a fully-migrated database.
        await subscriptionRepository.update({ id: activeSub.id, quantity: newSeats });
      }
    }

    return organization;
  });
}
