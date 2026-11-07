import { CreditHolderType, type PurchaseReversalReason } from '@bike4mind/common';
import { CreditTransaction, User, creditTransactionRepository, userRepository } from '@bike4mind/database';

/**
 * Clears User.lastCreditsPurchasedAt (the paid-standing stamp) from users nothing backs any more:
 * no completed, unreversed credit purchase. Like the webhook, an active subscription does not keep a
 * stamp: it confers standing on its own. Purchases that Stripe shows fully refunded or lost to a
 * dispute are marked reversed first, the same way the webhook does
 * (apps/client/server/billing/purchaseReversal.ts).
 *
 * Dry run writes nothing. A purchase row with no owner id that no Stripe customer resolves might back
 * a stamped user, so an apply run with any such row stops before its first write, and a dry run says
 * so. A row naming a deleted user cannot back a live stamp and does not block.
 */

export type PurchaseClassification =
  { kind: 'reversed'; reason: PurchaseReversalReason } | { kind: 'standing' } | { kind: 'unknown'; error: string };

export type UserVerdict = {
  userId: string;
  verdict: 'keep' | 'clear';
  reason: 'purchase' | 'error' | 'stamp_changed' | 'no_backing';
};

export type OwnerlessPurchase = {
  transactionId: string;
  paymentIntentId: string | null;
  resolvedUserId: string | null;
  /** No owner id and no resolved user: this row stops an apply run. */
  blocking: boolean;
};

export type ReconcileResult = {
  apply: boolean;
  /** True when an apply run stopped before writing because a blocking purchase row exists. */
  aborted: boolean;
  /** Blocking purchase rows; an apply run aborts when this is above zero, a dry run only reports it. */
  blocking: number;
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

export async function reconcilePurchaseStamps(options: ReconcileOptions): Promise<ReconcileResult> {
  const { apply, classifyPurchase, resolveOwnerByPaymentIntent, notify } = options;
  const log = options.log ?? console.log;
  const result: ReconcileResult = {
    apply,
    aborted: false,
    blocking: 0,
    users: [],
    reversals: [],
    ownerless: [],
    errors: [],
    cleared: 0,
  };
  // One entry per id: an intent whose Stripe read failed fails again in the owner lookup.
  const errorIds = new Set<string>();
  const recordError = (id: string, error: unknown) => {
    if (errorIds.has(id)) return;
    errorIds.add(id);
    result.errors.push({ id, message: message(error) });
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

  const stampedIds = new Set(
    (await User.find({ lastCreditsPurchasedAt: { $ne: null } }, { _id: 1 }).lean<{ _id: unknown }[]>()).map(u =>
      String(u._id)
    )
  );
  const userOwnerIds = [
    ...new Set(rows.filter(r => r.ownerType === CreditHolderType.User && r.ownerId).map(r => r.ownerId!)),
  ];
  const existing = new Set(
    (
      await User.find({ _id: { $in: userOwnerIds.filter(id => OBJECT_ID.test(id)) } }, { _id: 1 }).lean<
        { _id: unknown }[]
      >()
    ).map(u => String(u._id))
  );

  // Only rows that can matter for a stamped user cost a Stripe call. A user stamped after the read above
  // is still protected on apply by decide()'s findUnreversedPurchase re-check; a dry run may over-report them.
  const standingRows: PurchaseRow[] = [];
  for (const row of rows) {
    if (row.ownerType !== CreditHolderType.User) continue;
    if (row.ownerId && existing.has(row.ownerId) && !stampedIds.has(row.ownerId)) continue;
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
    if (classification.kind === 'unknown') recordError(pi, classification.error);
    standingRows.push(row);
  }

  const backed = new Set<string>();
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
        recordError(pi, error);
      }
    }
    // A named owner that no longer exists backs no stamp: stamps and findUnreversedPurchase key on live user ids.
    const blocking = !resolvedUserId && !row.ownerId;
    result.ownerless.push({ transactionId: String(row._id), paymentIntentId: pi, resolvedUserId, blocking });
    if (resolvedUserId) backed.add(resolvedUserId);
    if (blocking) result.blocking++;
  }

  if (result.blocking > 0) {
    const what = `${result.blocking} purchase row(s) have no owner id and no Stripe customer that maps to a user`;
    if (apply) {
      log(`Aborting before any write: ${what}`);
      result.aborted = true;
      return result;
    }
    log(`WARNING: --apply would abort before any write: ${what}`);
  }

  const failedReversals = new Set<string>();
  for (const reversal of result.reversals) {
    if (!apply) {
      log(`Would reverse purchase ${reversal.paymentIntentId} (${reversal.reason})`);
      continue;
    }
    try {
      await creditTransactionRepository.markPurchaseReversed(reversal.paymentIntentId, reversal.reason);
      log(`Reversed purchase ${reversal.paymentIntentId} (${reversal.reason})`);
    } catch (error) {
      // The row stays unreversed, so decide()'s findUnreversedPurchase re-check still keeps its owner.
      recordError(reversal.paymentIntentId, error);
      failedReversals.add(reversal.paymentIntentId);
    }
  }
  if (failedReversals.size > 0) {
    result.reversals = result.reversals.filter(r => !failedReversals.has(r.paymentIntentId));
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
    if (!apply) return { userId, verdict: 'clear', reason: 'no_backing' };

    try {
      // A purchase can land after the candidate read above.
      if (await creditTransactionRepository.findUnreversedPurchase(userId, CreditHolderType.User)) {
        return { userId, verdict: 'keep', reason: 'purchase' };
      }
      if (!(await userRepository.clearPurchaseStampIfUnchanged(userId, stamp))) {
        return { userId, verdict: 'keep', reason: 'stamp_changed' };
      }
    } catch (error) {
      recordError(userId, error);
      return { userId, verdict: 'keep', reason: 'error' };
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
