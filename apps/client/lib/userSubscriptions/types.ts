import { IBaseRepository, IMongoDocument, SettingKey } from '@bike4mind/common';
import Stripe from 'stripe';
import type { ISubscription } from '@client/lib/subscriptions/types';

export enum SubscriptionPlanInterval {
  Monthly = 'monthly',
  Yearly = 'yearly',
}

export enum UserSubscriptionTier {
  Basic = 1,
  Pro = 2,
}

export type SubscriptionPlanDetail = {
  /**
   * Stripe Price ID
   */
  priceId: string;
  interval: SubscriptionPlanInterval;
  name: string;
  credits: number;
  /**
   * Ordinal position in the B4M plan ladder, used only by the cross-plan change
   * flow (isUpgrade/isSameTier in pages/api/subscriptions/change.ts). OPTIONAL:
   * a plan with no tier is not part of that ladder and cannot be changed into
   * or out of via `/api/subscriptions/change`; the handler rejects tier-less
   * plans. Standalone, single-tier products omit it so they can never be
   * silently swapped against a same-tier B4M plan.
   */
  tier?: UserSubscriptionTier;
  features: string[];
  description: string;
  /**
   * Hide this plan from the generic B4M plan lists (the credits/upgrade modal).
   * Set for plans sold through their own separate product surface so they don't
   * leak into the B4M upsell UI. The plan stays in SUBSCRIPTION_PLANS /
   * SUBSCRIPTION_PLANS_MAP for admin-grant validation and webhook
   * credit-granting.
   */
  hidden?: boolean;
  /**
   * Generic launch/availability gate. When set, this plan is publicly purchasable
   * only while the named admin-settings boolean is ON; the public subscribe
   * endpoint refuses checkout otherwise (and paywall UIs can show "coming soon").
   * Product-neutral — any plan may opt in, and a fork with no such plan simply
   * has nothing to gate. Admin comp-grants are unaffected. Omitted = always
   * purchasable (the default for B4M's own plans).
   */
  availabilityFlag?: SettingKey;
};

export interface IUserSubscription extends IMongoDocument {
  /**
   * Stripe Subscription ID. Absent for admin-granted user subscriptions
   * (source === 'admin_grant') that have no Stripe-issued ID.
   */
  subscriptionId?: string;
  /** Stripe Subscription Product Price ID */
  priceId: string;
  status: Stripe.Subscription.Status;
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
  userId: string;
  /**
   * Custom credits per billing cycle. If set, overrides the default plan credits.
   */
  customCreditsPerCycle?: number;
}

export interface IUserSubscriptionRepository extends IBaseRepository<IUserSubscription> {
  /**
   * Find all subscriptions with user details
   */
  findWithUserDetails(
    query: string,
    page: number,
    limit: number
  ): Promise<{
    subscriptions: IUserSubscription[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }>;

  findActiveSubscriptionsByUserId(userId: string): Promise<IUserSubscription[]>;
  /**
   * Find subscription by priceId and userId
   */
  findByPriceIdAndUserId(priceId: string, userId: string): Promise<IUserSubscription | null>;

  updateByStripeSubscriptionId(
    subscriptionId: string,
    data: Partial<IUserSubscription>
  ): Promise<IUserSubscription | null>;

  findBySubscriptionId(subscriptionId: string): Promise<IUserSubscription | null>;
}

/**
 * Map Subscription to UserSubscription format for backward compatibility
 * @param sub Subscription record from the unified Subscription collection (already plain object from .lean({ virtuals: true }))
 * @returns UserSubscription interface with userId field (without polymorphic ownerId/ownerType fields)
 * @throws Error if subscription is not a user subscription (ownerType !== 'User')
 */
export function subscriptionToUserSubscription(sub: ISubscription & IMongoDocument): IUserSubscription {
  if (sub.ownerType !== 'User') {
    throw new Error(`Cannot convert non-user subscription (ownerType=${sub.ownerType}) to UserSubscription`);
  }

  // Destructure to remove polymorphic fields (ownerId, ownerType) from the unified Subscription model
  // This prevents the resulting object from having both `userId` and `ownerId` fields
  // Map ownerId -> userId to maintain backward compatibility with IUserSubscription interface
  const { ownerId, ownerType, ...rest } = sub;

  return {
    ...rest,
    userId: ownerId, // Map polymorphic ownerId to UserSubscription's userId field
  };
}

/**
 * Map multiple Subscriptions to UserSubscription format
 * Filters out non-user subscriptions automatically
 * @param subscriptions Array of Subscription records
 * @returns Array of UserSubscription interfaces
 */
export function subscriptionsToUserSubscriptions(
  subscriptions: (ISubscription & IMongoDocument)[]
): IUserSubscription[] {
  return subscriptions.filter(sub => sub.ownerType === 'User').map(subscriptionToUserSubscription);
}
