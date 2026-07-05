import {
  GenericCreditAddTransaction,
  ICreditHolder,
  ICreditHolderMethods,
  ICreditTransactionRepository,
  PurchaseTransaction,
  ReceivedCreditTransaction,
  SubscriptionCreditTransaction,
} from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

export interface AddCreditsAdapters {
  db: {
    creditTransactions: ICreditTransactionRepository;
  };
  creditHolderMethods: ICreditHolderMethods;
}

/**
 * Discriminated union for adding credits
 */
export const AddCreditsSchema = z.discriminatedUnion('type', [
  PurchaseTransaction.omit({ createdAt: true, updatedAt: true }),
  SubscriptionCreditTransaction.omit({ createdAt: true, updatedAt: true }),
  GenericCreditAddTransaction.omit({ createdAt: true, updatedAt: true }),
  ReceivedCreditTransaction.omit({ createdAt: true, updatedAt: true }),
]);

export type AddCreditsParameters = z.infer<typeof AddCreditsSchema>;

/**
 * Add credits to a User or Organization and create a corresponding transaction record
 */
export async function addCredits(
  parameters: AddCreditsParameters,
  { db, creditHolderMethods }: AddCreditsAdapters
): Promise<ICreditHolder> {
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
      description: description || 'Generic credit addition',
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
    const currentEntity = await creditHolderMethods.incrementCredits(ownerId, 0);
    if (!currentEntity) {
      throw new BadRequestError('Failed to load credit holder for idempotent add');
    }
    return currentEntity;
  }

  // Transaction record committed - now safe to credit the balance exactly once.
  const updatedEntity = await creditHolderMethods.incrementCredits(ownerId, credits, {
    updateLastCreditsPurchasedAt: type === 'purchase',
  });
  if (!updatedEntity) {
    throw new BadRequestError('Failed to update credits');
  }

  return updatedEntity;
}
