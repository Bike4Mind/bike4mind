import { CreditHolderType, type PurchaseReversalReason } from '@bike4mind/common';
import {
  CreditTransaction,
  User,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';

/**
 * Clears User.lastCreditsPurchasedAt (the paid-standing stamp) from users nothing backs any more:
 * no completed, unreversed credit purchase and no active subscription of their own or through an
 * org seat. Purchases that Stripe shows fully refunded or lost to a dispute are marked reversed
 * first, the same way the webhook does (apps/client/server/billing/purchaseReversal.ts).
 *
 * Dry run writes nothing. A purchase row whose owner cannot be found might back a stamped user, so
 * an apply run with any such unresolved row stops before its first write.
 */

export type PurchaseClassification =
  { kind: 'reversed'; reason: PurchaseReversalReason } | { kind: 'standing' } | { kind: 'unknown'; error: string };

export type UserVerdict = {
  userId: string;
  verdict: 'keep' | 'clear';
  reason: 'purchase' | 'subscription' | 'error' | 'stamp_changed' | 'no_backing';
};

export type OwnerlessPurchase = {
  transactionId: string;
  paymentIntentId: string | null;
  resolvedUserId: string | null;
};

export type ReconcileResult = {
  apply: boolean;
  /** True when an apply run stopped before writing because an ownerless purchase stayed unresolved. */
  aborted: boolean;
  users: UserVerdict[];
  reversals: { paymentIntentId: string; reason: PurchaseReversalReason; ownerId: string; ownerType: string }[];
  ownerless: OwnerlessPurchase[];
  errors: { id: string; message: string }[];
  cleared: number;
};

export type ReconcileOptions = {
  apply: boolean;
  classifyPurchase: (paymentIntentId: string) => Promise<PurchaseClassification>;
  resolveOwnerByPaymentIntent: (paymentIntentId: string) => Promise<string | null>;
  hasActiveSubscription?: (userId: string) => Promise<boolean>;
  /** Pushes the client cache invalidation after a stamp is cleared; failures are ignored. */
  notify: (userId: string) => Promise<unknown>;
  log?: (message: string) => void;
};

type PurchaseRow = {
  _id: unknown;
  ownerId?: string | null;
  ownerType?: string | null;
  stripePaymentIntentId?: string | null;
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Mirrors getActiveSubscriptionsForUser in apps/client/server/entitlements/activeSubscriptions.ts
 * in strict mode (own rows plus every plan-holder org's rows); keep the two in sync.
 */
export async function hasActiveSubscriptionForUser(userId: string): Promise<boolean> {
  const own = await subscriptionRepository.findActiveUserSubscriptions(userId);
  if (own.length > 0) return true;
  const orgIds = await organizationRepository.findPlanHolderOrgIds(userId);
  const orgRows = await subscriptionRepository.findActiveSubscriptionsByOwners(
    SubscriptionOwnerType.Organization,
    orgIds
  );
  return orgRows.length > 0;
}

export async function reconcilePurchaseStamps(options: ReconcileOptions): Promise<ReconcileResult> {
  const { apply, classifyPurchase, resolveOwnerByPaymentIntent, notify } = options;
  const hasActiveSubscription = options.hasActiveSubscription ?? hasActiveSubscriptionForUser;
  const log = options.log ?? console.log;
  const result: ReconcileResult = {
    apply,
    aborted: false,
    users: [],
    reversals: [],
    ownerless: [],
    errors: [],
    cleared: 0,
  };

  // Same filter as findUnreversedPurchase in packages/database CreditTransactionModel.
  const rows = await CreditTransaction.find(
    {
      type: 'purchase',
      reversedAt: null,
      $or: [{ status: 'completed' }, { status: { $exists: false } }, { status: null }],
    },
    { ownerId: 1, ownerType: 1, stripePaymentIntentId: 1 }
  ).lean<PurchaseRow[]>();

  const standingRows: PurchaseRow[] = [];
  for (const row of rows) {
    const pi = row.stripePaymentIntentId;
    if (!pi) {
      standingRows.push(row);
      continue;
    }
    let classification: PurchaseClassification;
    try {
      classification = await classifyPurchase(pi);
    } catch (error) {
      classification = { kind: 'unknown', error: message(error) };
    }
    if (classification.kind === 'reversed') {
      result.reversals.push({
        paymentIntentId: pi,
        reason: classification.reason,
        ownerId: row.ownerId ?? '',
        ownerType: row.ownerType ?? '',
      });
      continue;
    }
    if (classification.kind === 'unknown') result.errors.push({ id: pi, message: classification.error });
    standingRows.push(row);
  }

  const userOwnerIds = [
    ...new Set(standingRows.filter(r => r.ownerType === CreditHolderType.User && r.ownerId).map(r => r.ownerId!)),
  ];
  const existing = new Set(
    (
      await User.find({ _id: { $in: userOwnerIds.filter(id => OBJECT_ID.test(id)) } }, { _id: 1 }).lean<
        { _id: unknown }[]
      >()
    ).map(u => String(u._id))
  );

  const backed = new Set<string>();
  let blocking = 0;
  for (const row of standingRows) {
    if (row.ownerType !== CreditHolderType.User) continue;
    if (row.ownerId && existing.has(row.ownerId)) {
      backed.add(row.ownerId);
      continue;
    }
    const pi = row.stripePaymentIntentId ?? null;
    let resolvedUserId: string | null = null;
    if (pi) {
      try {
        resolvedUserId = await resolveOwnerByPaymentIntent(pi);
      } catch (error) {
        result.errors.push({ id: pi, message: message(error) });
      }
    }
    result.ownerless.push({ transactionId: String(row._id), paymentIntentId: pi, resolvedUserId });
    if (resolvedUserId) backed.add(resolvedUserId);
    else blocking++;
  }

  if (apply && blocking > 0) {
    log(`Aborting before any write: ${blocking} purchase row(s) have no resolvable owner`);
    result.aborted = true;
    return result;
  }

  if (apply) {
    for (const reversal of result.reversals) {
      await creditTransactionRepository.markPurchaseReversed(reversal.paymentIntentId, reversal.reason);
    }
  }
  for (const reversal of result.reversals) {
    log(`${apply ? 'Reversed' : 'Would reverse'} purchase ${reversal.paymentIntentId} (${reversal.reason})`);
  }

  const stamped = User.find({ lastCreditsPurchasedAt: { $ne: null } }, { _id: 1, lastCreditsPurchasedAt: 1 })
    .lean<{ _id: unknown; lastCreditsPurchasedAt: Date }[]>()
    .cursor();
  for await (const user of stamped) {
    const userId = String(user._id);
    const verdict = await decide(userId, user.lastCreditsPurchasedAt);
    result.users.push(verdict);
    log(`${verdict.verdict} ${userId} (${verdict.reason})`);
  }
  return result;

  async function decide(userId: string, stamp: Date): Promise<UserVerdict> {
    if (backed.has(userId)) return { userId, verdict: 'keep', reason: 'purchase' };
    try {
      if (await hasActiveSubscription(userId)) return { userId, verdict: 'keep', reason: 'subscription' };
    } catch (error) {
      result.errors.push({ id: userId, message: message(error) });
      return { userId, verdict: 'keep', reason: 'error' };
    }
    if (!apply) return { userId, verdict: 'clear', reason: 'no_backing' };

    // A purchase can land after the candidate read above.
    if (await creditTransactionRepository.findUnreversedPurchase(userId, CreditHolderType.User)) {
      return { userId, verdict: 'keep', reason: 'purchase' };
    }
    if (!(await userRepository.clearPurchaseStampIfUnchanged(userId, stamp))) {
      return { userId, verdict: 'keep', reason: 'stamp_changed' };
    }
    result.cleared++;
    try {
      await notify(userId);
    } catch (error) {
      log(`Cleared ${userId} but the client notification failed: ${message(error)}`);
    }
    return { userId, verdict: 'clear', reason: 'no_backing' };
  }
}
