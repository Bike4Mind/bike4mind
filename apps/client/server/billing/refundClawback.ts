import { creditLotRepository, creditTransactionRepository, userRepository } from '@bike4mind/database';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 11000;

/**
 * Claws back the share of a credit purchase that one Stripe refund returned: refund / charge of the
 * purchased credits, from the user's balance and the purchase's credit lot. Idempotent per refund
 * through the stripeRefundId unique index, so the charge.refunded webhook and the early fraud
 * warning response (which refunds, then claws back at once) can both call it for the same refund.
 * Returns null when there was nothing to claw back or this refund was already processed.
 */
export async function clawbackRefundCredits(input: {
  userId: string;
  paymentIntentId: string;
  purchasedCredits: number;
  /** Captured charge amount, minor units. */
  chargeAmount: number;
  refund: { id: string; amount: number };
}): Promise<{ credits: number; ratio: number } | null> {
  const { userId, paymentIntentId, purchasedCredits, chargeAmount, refund } = input;
  const ratio = chargeAmount > 0 ? refund.amount / chargeAmount : 0;
  const credits = Math.round(purchasedCredits * ratio);
  if (credits <= 0) return null;

  try {
    await creditService.subtractCredits(
      {
        type: 'generic_deduct',
        ownerId: userId, // Always clawback from user, not org
        ownerType: CreditHolderType.User,
        credits,
        reason: 'refund_clawback',
        stripeRefundId: refund.id,
        description: `Refund clawback: Stripe refund ${refund.id} (${Math.round(ratio * 100)}% of purchase)`,
      },
      {
        db: { creditTransactions: creditTransactionRepository },
        creditHolderMethods: userRepository,
      }
    );
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }

  // Proportionally shrink the matching pack lot's remaining balance. No-op if no lot matches.
  await creditService.clawbackCreditLotsByStripeRef(paymentIntentId, 'proportional', credits, {
    db: { creditLots: creditLotRepository },
  });
  return { credits, ratio };
}
