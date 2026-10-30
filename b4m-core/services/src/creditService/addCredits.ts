import {
  GenericCreditAddTransaction,
  ICreditHolder,
  ICreditHolderMethods,
  ICreditLotRepository,
  ICreditTransactionRepository,
  PurchaseTransaction,
  ReceivedCreditTransaction,
  SubscriptionCreditTransaction,
} from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { stampCreditLot } from './stampCreditLot';
import type { CreditLedgerWrite } from './ledgerWrite';

/** Raised when a replayed `transactionId` must fail rather than answer idempotently. */
export class DuplicateCreditTransactionError extends Error {
  constructor() {
    super('A credit transaction already exists for this transactionId');
    this.name = 'DuplicateCreditTransactionError';
  }
}

export interface AddCreditsAdapters {
  db: {
    creditTransactions: ICreditTransactionRepository;
    /**
     * Optional: when provided, addCredits stamps a dated-expiry CreditLot
     * for the grant (best-effort - see stampCreditLot). Omit to leave the
     * grant unstamped; the daily sweep's drift-tolerant clamp absorbs it.
     */
    creditLots?: ICreditLotRepository;
  };
  creditHolderMethods: ICreditHolderMethods;
  /**
   * Reference stamped on the grant's lot when the grant has no stripePaymentIntentId, so a later
   * clawback can find the lot (clawbackCreditLotsByStripeRef). Ignored when a payment intent is set.
   */
  lotRef?: string;
  /**
   * What a replayed `transactionId` does. 'return' (default) re-reads the holder with a net-zero
   * increment. 'throw' raises DuplicateCreditTransactionError before touching the session - what
   * an in-transaction caller needs, because the duplicate write has already aborted it and any
   * further operation there raises a transient NoSuchTransaction the driver would retry.
   */
  duplicateTransactionId?: 'return' | 'throw';
}

/**
 * A `generic_add` row is otherwise indistinguishable from any other grant, so the writer must say
 * what it is: `reason` is the machine label (e.g. `signup_tranche`, `referral_reward`) and
 * `description` the human one shown in credit histories. `reason` stays optional only because an
 * overlay refund caller does not pass one yet; every in-repo producer does.
 */
const GenericCreditAddParameters = GenericCreditAddTransaction.omit({ createdAt: true, updatedAt: true }).extend({
  description: z.string().trim().min(1),
});

/**
 * Discriminated union for adding credits
 */
export const AddCreditsSchema = z.discriminatedUnion('type', [
  PurchaseTransaction.omit({ createdAt: true, updatedAt: true }),
  SubscriptionCreditTransaction.omit({ createdAt: true, updatedAt: true }),
  GenericCreditAddParameters,
  ReceivedCreditTransaction.omit({ createdAt: true, updatedAt: true }),
]);

export type AddCreditsParameters = z.infer<typeof AddCreditsSchema>;

/**
 * Add credits to a User or Organization and create a corresponding transaction record.
 * Returns the holder and the id of the CreditTransaction row it wrote (undefined on an idempotent retry).
 */
export async function addCreditsWithLedgerRow(
  parameters: AddCreditsParameters,
  { db, creditHolderMethods, duplicateTransactionId = 'return', lotRef }: AddCreditsAdapters
): Promise<CreditLedgerWrite> {
  const params = secureParameters(parameters, AddCreditsSchema);
  const { ownerId, ownerType, credits, type, description, metadata } = params;

  // Write the CreditTransaction record FIRST. Its unique keys (transactionId,
  // stripePaymentIntentId) are the idempotency gate - they must commit before
  // the balance is mutated so a duplicate call can never double-credit. A
  // swallowed duplicate (transactionId E11000) returns null; any other E11000
  // (e.g. stripePaymentIntentId) rethrows here, before any increment.
  let tx;
  if (type === 'purchase') {
    tx = await db.creditTransactions.createTransaction('purchase', {
      ownerId,
      ownerType,
      credits: Math.abs(credits),
      description: description || 'Credit purchase',
      metadata,
      status: params.status,
      stripePaymentIntentId: params.stripePaymentIntentId,
      packageId: params.packageId,
      amount: params.amount,
      // Backward compatibility
      userId: params.userId,
    });
  } else if (type === 'subscription') {
    tx = await db.creditTransactions.createTransaction('subscription', {
      ownerId,
      ownerType,
      credits: Math.abs(credits),
      description: description || 'Subscription credit allocation',
      metadata,
      stripePaymentIntentId: params.stripePaymentIntentId,
    });
  } else if (type === 'received_credit') {
    tx = await db.creditTransactions.createTransaction('received_credit', {
      ownerId,
      ownerType,
      credits: Math.abs(credits),
      senderId: params.senderId,
      senderType: params.senderType,
      description: description || 'Received credit',
      metadata,
    });
  } else {
    tx = await db.creditTransactions.createTransaction('generic_add', {
      ownerId,
      ownerType,
      credits: Math.abs(credits),
      description,
      metadata,
      reason: params.reason,
      transactionId: params.transactionId,
      // Backward compatibility
      userId: params.userId,
    });
  }

  // Duplicate transactionId (idempotent retry / concurrent handler): the record
  // already exists and the balance was already credited by the first call. Do
  // NOT credit again - a net-zero increment returns the current holder without
  // changing the balance (ICreditHolderMethods exposes no read-only fetch).
  if (tx === null) {
    if (duplicateTransactionId === 'throw') {
      throw new DuplicateCreditTransactionError();
    }
    const currentEntity = await creditHolderMethods.incrementCredits(ownerId, 0);
    if (!currentEntity) {
      throw new BadRequestError('Failed to load credit holder for idempotent add');
    }
    return { creditHolder: currentEntity, creditTransactionId: undefined };
  }

  // Transaction record committed - now safe to credit the balance exactly once.
  const updatedEntity = await creditHolderMethods.incrementCredits(ownerId, credits, {
    updateLastCreditsPurchasedAt: type === 'purchase',
  });
  if (!updatedEntity) {
    throw new BadRequestError('Failed to update credits');
  }

  if (db.creditLots) {
    await stampCreditLot(
      {
        ownerId,
        ownerType,
        amount: Math.abs(credits),
        grantType: type,
        stripeRef: ('stripePaymentIntentId' in params ? params.stripePaymentIntentId : undefined) ?? lotRef,
      },
      { db: { creditLots: db.creditLots } }
    );
  }

  return { creditHolder: updatedEntity, creditTransactionId: tx.id };
}

/** addCredits for callers that need the ledger row id; see addCreditsWithLedgerRow. */
export async function addCredits(
  parameters: AddCreditsParameters,
  adapters: AddCreditsAdapters
): Promise<ICreditHolder> {
  const { creditHolder } = await addCreditsWithLedgerRow(parameters, adapters);
  return creditHolder;
}
