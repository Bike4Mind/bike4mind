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

  updateByStripeSubscriptionId(subscriptionId: string, data: Partial<ISubscription>): Promise<ISubscription | null>;
}
