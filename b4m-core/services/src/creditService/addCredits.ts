import {
  GenericCreditAddTransaction,
  ICreditHolder,
  ICreditHolderMethods,
  ICreditLotRepository,
  ICreditTransactionRepository,
  PurchaseTransaction,
  ReceivedCreditTransaction,
  SubscriptionCreditTransaction,
  UsageFundingSource,
} from '@bike4mind/common';
import { markTransactionForRollback, runAfterCommit, withTransaction } from '@bike4mind/db-core';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { callerTransactionSession } from '../userService/callerTransaction';
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
   * increment. 'throw' raises DuplicateCreditTransactionError. If the insert itself collides
   * inside a caller's transaction, either mode throws because that session can no longer commit.
   */
  duplicateTransactionId?: 'return' | 'throw';
  /**
   * Stamped on the grant's CreditLot when its type would misstate the funding, e.g. 'granted'
   * for an admin-comped subscription. See ICreditLot.fundingSource.
   */
  lotFundingSource?: UsageFundingSource;
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

async function writeCreditGrant(params: AddCreditsParameters, { db, creditHolderMethods }: AddCreditsAdapters) {
  const { ownerId, ownerType, credits, type, description, metadata } = params;

  // The ledger's unique keys gate the balance increment.
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

  if (tx === null) throw new DuplicateCreditTransactionError();

  const updatedEntity = await creditHolderMethods.incrementCredits(ownerId, credits, {
    updateLastCreditsPurchasedAt: type === 'purchase',
  });
  if (!updatedEntity) {
    throw new BadRequestError('Failed to update credits');
  }

  return { creditHolder: updatedEntity, creditTransactionId: tx.id };
}

async function loadIdempotentGrant(
  ownerId: string,
  creditHolderMethods: ICreditHolderMethods
): Promise<CreditLedgerWrite> {
  const creditHolder = await creditHolderMethods.incrementCredits(ownerId, 0);
  if (!creditHolder) throw new BadRequestError('Failed to load credit holder for idempotent add');
  return { creditHolder, creditTransactionId: undefined };
}

/**
 * Add credits to a User, Organization or Agent and write the matching CreditTransaction row in one
 * transaction: the caller's when one is open, else its own. Returns the holder and the id of the row
 * it wrote (undefined on an idempotent replay).
 */
export async function addCreditsWithLedgerRow(
  parameters: AddCreditsParameters,
  adapters: AddCreditsAdapters
): Promise<CreditLedgerWrite> {
  const params = secureParameters(parameters, AddCreditsSchema);
  const { ownerId, ownerType, credits, type } = params;
  const { db, creditHolderMethods, duplicateTransactionId = 'return', lotRef, lotFundingSource } = adapters;
  const session = callerTransactionSession();

  // A duplicate-key insert would abort the caller's transaction even on an ordinary replay.
  if (
    session &&
    type === 'generic_add' &&
    params.transactionId !== undefined &&
    (await db.creditTransactions.findOne({ transactionId: params.transactionId }))
  ) {
    if (duplicateTransactionId === 'throw') throw new DuplicateCreditTransactionError();
    return loadIdempotentGrant(ownerId, creditHolderMethods);
  }

  let grant: CreditLedgerWrite;
  try {
    const write = () => writeCreditGrant(params, adapters);
    grant = session ? await write() : await withTransaction(write);
  } catch (error) {
    if (session) {
      markTransactionForRollback(session, error);
    } else if (duplicateTransactionId === 'return' && error instanceof DuplicateCreditTransactionError) {
      return loadIdempotentGrant(ownerId, creditHolderMethods);
    }
    throw error;
  }

  const { creditLots } = db;
  if (creditLots) {
    const stamp = () =>
      stampCreditLot(
        {
          ownerId,
          ownerType,
          amount: Math.abs(credits),
          grantType: type,
          stripeRef: ('stripePaymentIntentId' in params ? params.stripePaymentIntentId : undefined) ?? lotRef,
          fundingSource: lotFundingSource,
        },
        { db: { creditLots } }
      );
    if (!session || !runAfterCommit(session, `creditLot|${grant.creditTransactionId}`, stamp)) await stamp();
  }

  return grant;
}

/** addCredits for callers that need the ledger row id; see addCreditsWithLedgerRow. */
export async function addCredits(
  parameters: AddCreditsParameters,
  adapters: AddCreditsAdapters
): Promise<ICreditHolder> {
  const { creditHolder } = await addCreditsWithLedgerRow(parameters, adapters);
  return creditHolder;
}
