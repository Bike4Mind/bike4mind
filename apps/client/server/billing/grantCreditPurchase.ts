import { CreditHolderType, CreditPurchaseStatus } from '@bike4mind/common';
import { creditLotRepository, creditTransactionRepository, userRepository, withTransaction } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { creditService } from '@bike4mind/services';

export type CreditPurchaseGrant = {
  userId: string;
  paymentIntentId: string;
  credits: number;
  /** Minor units (cents). */
  amount: number;
  packageId?: string;
  environment?: string;
  paymentMethod?: string;
};

export type CreditPurchaseGrantResult = 'granted' | 'already_granted';

/**
 * Grants a paid credit purchase exactly once per payment intent.
 *
 * The ledger row and the balance increment commit in one transaction. addCredits writes them as
 * two separate writes, and the webhook treats an existing row as "already granted", so a failure
 * between them would leave a row with no credits behind it that every Stripe redelivery then
 * acknowledged. Inside the transaction, either both writes land or neither does, and a redelivery
 * after a failure grants for real. Same shape as pages/api/gears/claim.ts.
 */
export async function grantCreditPurchase(
  grant: CreditPurchaseGrant,
  logger?: Logger
): Promise<CreditPurchaseGrantResult> {
  let result: CreditPurchaseGrantResult;
  try {
    result = await withTransaction(
      async (): Promise<CreditPurchaseGrantResult> => {
        // Read before writing: a concurrent delivery that committed first shows up here on the
        // transient-error retry. Left to addCredits, the insert would hit the duplicate key,
        // which aborts the transaction on every retry.
        if (await creditTransactionRepository.findByPaymentIntentId(grant.paymentIntentId)) {
          return 'already_granted';
        }
        await creditService.addCredits(
          {
            type: 'purchase',
            ownerId: grant.userId,
            ownerType: CreditHolderType.User,
            amount: grant.amount,
            credits: grant.credits,
            status: CreditPurchaseStatus.Completed,
            stripePaymentIntentId: grant.paymentIntentId,
            packageId: grant.packageId,
            metadata: {
              environment: grant.environment,
              paymentMethod: grant.paymentMethod,
            },
          },
          { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
        );
        return 'granted';
      },
      // Explicit rather than inherited from the cluster defaults: the committed row is the webhook's
      // "credits landed" signal, so it must not be readable before it is durable.
      { logger, readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
    );
  } catch (err) {
    // A duplicate on the payment intent means another delivery's transaction committed the row,
    // and with it the balance. Any other error, including another duplicate key, must still fail.
    const dup = err as { code?: number; keyPattern?: Record<string, number> } | null;
    if (dup?.code === 11000 && dup.keyPattern?.stripePaymentIntentId === 1) return 'already_granted';
    throw err;
  }

  // The pack lot stays outside the transaction: stamping is best-effort and swallows its own
  // errors, but a failed write inside a transaction aborts it and would fail the grant with it.
  if (result === 'granted') {
    await creditService.stampCreditLot(
      {
        ownerId: grant.userId,
        ownerType: CreditHolderType.User,
        amount: grant.credits,
        grantType: 'purchase',
        stripeRef: grant.paymentIntentId,
      },
      { db: { creditLots: creditLotRepository } }
    );
  }
  return result;
}
