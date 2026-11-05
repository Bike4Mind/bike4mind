import { creditTransactionRepository } from '@bike4mind/database';
import type { PurchaseReversalReason } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

export type PurchaseReversalOutcome = 'no_purchase' | 'recorded';

/**
 * Records that a credit purchase was fully refunded or lost a dispute. Idempotent, so a Stripe redelivery
 * is safe; throws on a DB error so the webhook rethrows and Stripe retries.
 */
export async function reversePurchaseStanding(
  { paymentIntentId, reason }: { paymentIntentId: string; reason: PurchaseReversalReason },
  logger: Logger
): Promise<PurchaseReversalOutcome> {
  const tx = await creditTransactionRepository.markPurchaseReversed(paymentIntentId, reason);
  if (!tx) {
    logger.debug(`No credit purchase for payment intent ${paymentIntentId}, nothing to reverse`);
    return 'no_purchase';
  }
  logger.info(`Marked purchase ${tx.id} reversed (${reason})`);
  return 'recorded';
}
