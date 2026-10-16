import { creditLotRepository, creditTransactionRepository, userRepository, withTransaction } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { CreditHolderType, dayjs } from '@bike4mind/common';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { subscriptionRepository } from '@server/models/Subscription';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { randomUUID } from 'crypto';

export type GrantIndividualAdminSubscriptionResult =
  | {
      status: 'granted';
      subscriptionId: string;
      priceId: string;
      periodEndsAt: Date;
      credits: number;
      /** Balance after the grant; null when the credit service did not return a holder. */
      currentCredits: number | null;
    }
  | { status: 'already_active' }
  | { status: 'unknown_plan' };

/**
 * Stripe-free individual subscription grant: a `SubscriptionSource.AdminGrant` row plus
 * `plan.credits * durationMonths` subscription credits, in one transaction. Shared by the admin
 * grant route and partner signup rules. Expected outcomes are returned, not thrown, so each
 * caller maps them to its own surface; unexpected errors still throw.
 * The already-active check is a plain read before the transaction, so concurrent callers can race it.
 *
 * - `skipIfAnyActiveIndividual`: also report `already_active` when the user has a non-terminal
 *   (e.g. active, trialing, past_due) individual subscription for ANY price (Stripe or admin grant),
 *   so an automated grant never stacks a second plan. The admin route leaves it off and keeps its
 *   per-price check.
 * - `subscriptionId`: a deterministic row id that makes the grant idempotent. A repeat or concurrent
 *   grant with the same id hits the unique `subscriptionId` index on the row insert, which runs
 *   before the credits are added, and is reported as `already_active`. Omitted, each call gets a
 *   fresh `admin_grant_<uuid>` (the admin route, where a human decides).
 *   (`addCredits` drops `transactionId` for `type: 'subscription'`, so the credit write cannot be
 *   the idempotency key.)
 */
export async function grantIndividualAdminSubscription(params: {
  userId: string;
  priceId: string;
  durationMonths: number;
  grantedBy: string;
  grantedReason?: string;
  skipIfAnyActiveIndividual?: boolean;
  subscriptionId?: string;
}): Promise<GrantIndividualAdminSubscriptionResult> {
  const { userId, priceId, durationMonths, grantedBy, grantedReason, skipIfAnyActiveIndividual } = params;

  const planDetail = SUBSCRIPTION_PLANS.find(plan => plan.priceId === priceId);
  if (!planDetail) return { status: 'unknown_plan' };

  // Per-price check is active-only; the any-price check covers every non-terminal status.
  const existingSubscription = await subscriptionRepository.findUserSubscriptionByPriceId(priceId, userId);
  if (existingSubscription) return { status: 'already_active' };
  if (skipIfAnyActiveIndividual) {
    const nonTerminalSubscriptions = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
      SubscriptionOwnerType.User,
      userId
    );
    if (nonTerminalSubscriptions.length > 0) return { status: 'already_active' };
  }

  const now = dayjs();
  const periodStartsAt = now.toDate();
  const periodEndsAt = now.add(durationMonths, 'months').toDate();
  const credits = planDetail.credits * durationMonths;
  // Sentinel id for admin grants - not a Stripe subscription, but the
  // unique index on subscriptionId is non-sparse (DocumentDB constraint),
  // so every row needs a real value (mirrors organizations/grant.ts).
  const subscriptionId = params.subscriptionId ?? `admin_grant_${randomUUID()}`;

  let currentCredits: number | null = null;
  try {
    await withTransaction(async () => {
      await subscriptionRepository.create({
        ownerType: SubscriptionOwnerType.User,
        ownerId: userId,
        subscriptionId,
        priceId,
        status: 'active',
        source: SubscriptionSource.AdminGrant,
        grantedBy,
        ...(grantedReason ? { grantedReason } : {}),
        periodStartsAt,
        periodEndsAt,
        quantity: 1, // Always 1 for individual subscriptions (not team seats)
        canceledAt: null,
      });

      const holder = await creditService.addCredits(
        {
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits,
          type: 'subscription',
          metadata: {},
        },
        {
          db: {
            creditTransactions: creditTransactionRepository,
            creditLots: creditLotRepository,
          },
          creditHolderMethods: userRepository,
        }
      );
      currentCredits = holder?.currentCredits ?? null;
    });
  } catch (error) {
    if (params.subscriptionId && isDuplicateKeyError(error)) return { status: 'already_active' };
    throw error;
  }

  return { status: 'granted', subscriptionId, priceId, periodEndsAt, credits, currentCredits };
}
