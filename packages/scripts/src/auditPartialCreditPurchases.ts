import { CreditHolderType } from '@bike4mind/common';
import { CreditLot, CreditTransaction, User, creditLotRepository, withTransaction } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type Stripe from 'stripe';

/**
 * Audit for credit purchases whose ledger row landed without the balance increment behind it.
 *
 * Before apps/client/server/billing/grantCreditPurchase.ts made the grant one transaction,
 * addCredits wrote the purchase row and then incremented the balance as a second write. A failure
 * between them left a row the webhook acknowledges as "already granted" on every redelivery.
 * There is no balance history, so a row is judged by two witnesses only the increment produces:
 * - a CreditLot stamped with the payment intent, written after the increment: proof of a grant.
 * - User.lastCreditsPurchasedAt, set in the same update as the increment. Unset or older than the
 *   row means nothing incremented after it: proof of no grant. Newer proves nothing, because a
 *   later purchase or an admin credit raise (userService/adminUpdate.ts) also moves it.
 * Everything else is unverifiable and is listed for manual review, never repaired.
 */

export type PurchaseVerdict = 'granted' | 'ungranted' | 'unverifiable' | 'backfilled';

export type PurchaseEvidence = {
  createdAt: Date;
  backfilledAt: Date | null;
  hasLot: boolean;
  lastCreditsPurchasedAt: Date | null;
  /** From when this stage is known to write lastCreditsPurchasedAt; null when it never has. */
  stampSince: Date | null;
};

export function classifyPurchase(evidence: PurchaseEvidence): { verdict: PurchaseVerdict; reason: string } {
  if (evidence.backfilledAt) return { verdict: 'backfilled', reason: 'repaired by an earlier run' };
  if (evidence.hasLot) return { verdict: 'granted', reason: 'pack lot exists' };
  if (!evidence.stampSince || evidence.createdAt < evidence.stampSince) {
    return { verdict: 'unverifiable', reason: 'predates the purchase stamp and has no lot' };
  }
  if (!evidence.lastCreditsPurchasedAt || evidence.lastCreditsPurchasedAt < evidence.createdAt) {
    return { verdict: 'ungranted', reason: 'no lot, and no purchase stamp since the row was written' };
  }
  return { verdict: 'unverifiable', reason: 'no lot, but a later purchase stamp may or may not be this one' };
}

/**
 * Why a payment intent does not back a repair, or null when it does. A refunded or disputed charge
 * already had its credits clawed back against the row, so it needs a person, not a blind grant.
 */
export function describePaymentIntentProblem(
  intent: Stripe.PaymentIntent,
  stage: string,
  credits: number
): string | null {
  if (intent.status !== 'succeeded') return `intent status is ${intent.status}`;
  if (intent.metadata?.environment !== stage) return `intent belongs to stage ${intent.metadata?.environment}`;
  if (Number(intent.metadata?.credits) !== credits) {
    return `intent is for ${intent.metadata?.credits} credits, row is for ${credits}`;
  }
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') return 'latest charge was not expanded';
  if (charge.disputed) return 'charge is disputed';
  if (charge.amount_refunded > 0) return `charge refunded ${charge.amount_refunded} of ${charge.amount}`;
  return null;
}

export type AuditedPurchase = {
  transactionId: string;
  paymentIntentId: string;
  ownerId: string;
  credits: number;
  createdAt: string;
  verdict: PurchaseVerdict;
  reason: string;
  /** Set on ungranted rows: why Stripe does not back a repair, or null when it does. */
  paymentIntentProblem?: string | null;
  repaired?: boolean;
  repairError?: string;
};

export type AuditOptions = {
  apply: boolean;
  /** Resolves to describePaymentIntentProblem's answer for the intent. */
  checkPaymentIntent: (paymentIntentId: string, credits: number) => Promise<string | null>;
  /** Overrides the stamp cutoff derived from the data. */
  stampSince?: Date;
  log?: (line: string) => void;
};

export type AuditResult = {
  stampSince: Date | null;
  purchases: AuditedPurchase[];
};

type PurchaseRow = {
  _id: { toString(): string };
  ownerId: string;
  ownerType: string;
  credits: number;
  stripePaymentIntentId: string;
  createdAt: Date;
  metadata?: { balanceBackfilledAt?: Date } | null;
};

/**
 * The earliest surviving stamp is a moment by which the stage was already writing it. Later
 * purchases overwrite older stamps, so this can only land after the real rollout, which errs
 * toward "unverifiable" and never toward a false "ungranted".
 */
async function deriveStampSince(): Promise<Date | null> {
  const earliest = await User.findOne({ lastCreditsPurchasedAt: { $ne: null } })
    .sort({ lastCreditsPurchasedAt: 1 })
    .select({ lastCreditsPurchasedAt: 1 })
    .lean();
  return earliest?.lastCreditsPurchasedAt ?? null;
}

/**
 * Credits the balance and marks the row in one transaction, so a re-run (or a crash between the
 * two writes) can never grant twice. The lot is stamped after commit, as grantCreditPurchase does.
 */
async function repairPurchase(row: PurchaseRow): Promise<boolean> {
  const repaired = await withTransaction(
    async session => {
      const now = new Date();
      // Pipeline update: metadata is Mixed and may be null on old rows, where a dotted $set fails.
      const marked = await CreditTransaction.updateOne(
        { _id: row._id, 'metadata.balanceBackfilledAt': { $exists: false } },
        [{ $set: { metadata: { $mergeObjects: [{ $ifNull: ['$metadata', {}] }, { balanceBackfilledAt: now }] } } }],
        { session }
      );
      if (marked.modifiedCount === 0) return false;
      const credited = await User.updateOne(
        { _id: row.ownerId },
        { $inc: { currentCredits: row.credits } },
        { session }
      );
      if (credited.matchedCount === 0) throw new Error(`User ${row.ownerId} not found`);
      return true;
    },
    { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
  );

  if (repaired) {
    await creditService.stampCreditLot(
      {
        ownerId: row.ownerId,
        ownerType: CreditHolderType.User,
        amount: row.credits,
        grantType: 'purchase',
        stripeRef: row.stripePaymentIntentId,
      },
      { db: { creditLots: creditLotRepository } }
    );
  }
  return repaired;
}

export async function auditPartialCreditPurchases(options: AuditOptions): Promise<AuditResult> {
  const log = options.log ?? console.log;
  const stampSince = options.stampSince ?? (await deriveStampSince());
  log(`Purchase stamp cutoff: ${stampSince?.toISOString() ?? 'none (stage never wrote one)'}`);

  const stampByOwner = new Map<string, Date | null>();
  const stampOf = async (ownerId: string) => {
    if (!stampByOwner.has(ownerId)) {
      const user = await User.findById(ownerId).select({ lastCreditsPurchasedAt: 1 }).lean();
      stampByOwner.set(ownerId, user?.lastCreditsPurchasedAt ?? null);
    }
    return stampByOwner.get(ownerId) ?? null;
  };

  const rows = CreditTransaction.find({ type: 'purchase', stripePaymentIntentId: { $type: 'string' } })
    .sort({ createdAt: 1 })
    .lean<PurchaseRow[]>()
    .cursor();

  const purchases: AuditedPurchase[] = [];
  for await (const row of rows) {
    const { verdict, reason } = classifyPurchase({
      createdAt: row.createdAt,
      backfilledAt: row.metadata?.balanceBackfilledAt ?? null,
      hasLot: (await CreditLot.exists({ stripeRef: row.stripePaymentIntentId })) !== null,
      // Purchases are only ever granted to users (webhook.ts resolves the buyer by Stripe customer).
      lastCreditsPurchasedAt: row.ownerType === CreditHolderType.User ? await stampOf(row.ownerId) : null,
      stampSince: row.ownerType === CreditHolderType.User ? stampSince : null,
    });
    const purchase: AuditedPurchase = {
      transactionId: row._id.toString(),
      paymentIntentId: row.stripePaymentIntentId,
      ownerId: row.ownerId,
      credits: row.credits,
      createdAt: row.createdAt.toISOString(),
      verdict,
      reason,
    };

    if (verdict === 'ungranted') {
      purchase.paymentIntentProblem = await options.checkPaymentIntent(row.stripePaymentIntentId, row.credits);
      if (options.apply && purchase.paymentIntentProblem === null) {
        // One row's failure (e.g. a deleted buyer) must not strand the rest; its transaction
        // rolled back, so the row stays ungranted and shows up again on the next run.
        try {
          purchase.repaired = await repairPurchase(row);
        } catch (error) {
          purchase.repaired = false;
          purchase.repairError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    purchases.push(purchase);
  }

  return { stampSince, purchases };
}
