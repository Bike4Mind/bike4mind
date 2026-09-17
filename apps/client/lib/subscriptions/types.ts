import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/database';
import { StripeSubscriptionMetadataSchema } from '@client/lib/subscriptions/schema';
import Stripe from 'stripe';
import { z } from 'zod';

export enum SubscriptionOwnerType {
  User = 'User',
  Organization = 'Organization',
}

export enum SubscriptionSource {
  Stripe = 'stripe',
  AdminGrant = 'admin_grant',
}

/**
 * Statuses Stripe will not move a subscription out of. A row in one of these is
 * finished: there is nothing left to cancel and Stripe rejects further updates.
 *
 * Scoped to the cancel path: its complement is what
 * `findCancelableUserSubscriptionByPriceId` and the cancel affordance filter on,
 * so a delinquent user can still stop their own dunning. Do NOT widen "does this
 * user have a plan" checks to that complement - entitlement, rate-tier and
 * plan-change checks are deliberately `status === 'active'`-only, and
 * `server/entitlements/index.ts` records why.
 */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'canceled',
  'incomplete_expired',
]);

export const isCancellableSubscriptionStatus = (status: Stripe.Subscription.Status): boolean =>
  !TERMINAL_SUBSCRIPTION_STATUSES.has(status);

/**
 * The subscription to show a user as their current plan: their active one, else the
 * first cancellable row. `/api/subscriptions/own` returns an unsorted `find`, so
 * without the active-first rule a stale delinquent row left behind by a re-subscribe
 * can be displayed as the current plan.
 *
 * Mirrors the precedence in `findCancelableUserSubscriptionByPriceId`
 * (`server/models/Subscription.ts`); the two must agree on which row is "the" plan.
 * Entitlement and rate-tier checks must not use this - see the docblock above.
 */
export function pickDisplayedSubscription<T extends { status: Stripe.Subscription.Status }>(
  subscriptions: readonly T[]
): T | undefined {
  return (
    subscriptions.find(sub => sub.status === 'active') ??
    subscriptions.find(sub => isCancellableSubscriptionStatus(sub.status))
  );
}

/**
 * Statuses where Stripe's billing is stuck: the current period is unpaid and
 * retries (and dunning email) keep running. Cancelling at period end would only
 * buy the customer more email for access they have not paid for, so these are
 * cancelled outright - and they are what the UI warns about.
 */
export const DELINQUENT_SUBSCRIPTION_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'past_due',
  'unpaid',
  'incomplete',
]);

export const isDelinquentSubscriptionStatus = (status: Stripe.Subscription.Status): boolean =>
  DELINQUENT_SUBSCRIPTION_STATUSES.has(status);

export interface ISubscription {
  ownerType: SubscriptionOwnerType;
  /** The document ID of the owner of the subscription */
  ownerId: string;

  /**
   * Stripe Subscription ID. Absent when source === 'admin_grant' and the org
   * has not yet been converted to a paid Stripe subscription.
   */
  subscriptionId?: string;
  /** Stripe Subscription Product Price ID */
  priceId: string;
  status: Stripe.Subscription.Status;
  /**
   * How this subscription came to exist. 'stripe' = paid (Stripe-managed),
   * 'admin_grant' = free org created by a super-admin. The discriminator is
   * read by the admin UI (badge), billing portal (gate), and conversion flow.
   */
  source: SubscriptionSource;
  /** Admin user who issued the grant (only set when source === 'admin_grant'). */
  grantedBy?: string;
  /** Free-text reason the grant was issued (audit). */
  grantedReason?: string;
  /**
   * This field is used to store the date when the subscription was canceled.
   */
  canceledAt: null | Date;
  /**
   * The start date of the current subscription period.
   */
  periodStartsAt: Date;
  /**
   * The end date of the current subscription period.
   */
  periodEndsAt: Date;
  /**
   * The quantity of the subscription. This can be used for subscriptions such as
   * the team plan, where we charge per seat.
   */
  quantity: number;
  /**
   * Custom credits per billing cycle. If set, overrides the default credits calculation.
   */
  customCreditsPerCycle?: number;
}

/**
 * Resolve `source` defensively for rows that may pre-date the source-field
 * migration. Mongoose schema defaults only fire on insert, not on read of
 * pre-existing documents, so a Subscription written before the schema change
 * comes back with `source === undefined`. Treat unknown legacy rows as Stripe-
 * managed (the historical default) UNLESS the row carries the synthetic
 * `admin_granted_*` subscriptionId pattern from the legacy grant endpoint.
 *
 * Lives here rather than in a service because the repository needs it too, and
 * the repository must not import a service that imports the repository.
 */
export function resolveSubscriptionSource(sub: Pick<ISubscription, 'source' | 'subscriptionId'>): SubscriptionSource {
  if (sub.source) return sub.source;
  if (sub.subscriptionId?.startsWith('admin_granted_')) return SubscriptionSource.AdminGrant;
  return SubscriptionSource.Stripe;
}

export type SubscriptionMetadata =
  | z.infer<typeof StripeSubscriptionMetadataSchema>
  | {
      // TODO: Remove this once we merge UserSubscription to Subscription
      ownerType: undefined;
      userId: string;
      stage: string;
      organizationId: string;
    };

export interface ISubscriptionRepository extends BaseRepository<ISubscription & IMongoDocument> {
  findByStripeSubscriptionId(subscriptionId: string): Promise<ISubscription | null>;

  findWithOwnerDetails(
    query: string,
    page: number,
    limit: number
  ): Promise<{
    subscriptions: ISubscription[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }>;

  findActiveSubscriptionsByOwner(ownerType: SubscriptionOwnerType, ownerId: string): Promise<ISubscription[]>;
  /**
   * Find a subscription by price ID and owner.
   * Used to check if a user is subscribed to a plan before they subscribe.
   */
  findByPriceIdAndOwner(
    priceId: string,
    ownerType: SubscriptionOwnerType,
    ownerId: string,
    status: ISubscription['status']
  ): Promise<ISubscription | null>;

  /**
   * Find the user subscription to cancel for `priceId` - anything except the two
   * terminal states. Unlike findActiveUserSubscriptions this includes
   * past_due/unpaid/incomplete rows, so a delinquent user can still stop dunning.
   * A Stripe-managed row wins over an admin grant, then active over stale.
   */
  findCancelableUserSubscriptionByPriceId(priceId: string, userId: string): Promise<ISubscription | null>;

  updateByStripeSubscriptionId(subscriptionId: string, data: Partial<ISubscription>): Promise<ISubscription | null>;
}
