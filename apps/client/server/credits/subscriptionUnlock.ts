import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import type { IUserDocument } from '@bike4mind/common';

const emailVerified = async (user: IUserDocument) => user.emailVerified;

type UnlockLogger = { warn: (message: string, meta?: Record<string, unknown>) => void };

/** Shared by the subscription and credit pack paths (creditPurchaseUnlock.ts). */
export async function unlockSignupGrantFromPayment(
  userId: string,
  reason: 'subscription' | 'credit_purchase',
  ledgerReason: string,
  logger?: UnlockLogger
) {
  const payer = await userRepository.findById(userId);
  // The payment event is not retried, so an unverified payer stays at the tranche until a later unlock.
  if (payer?.signupGrant?.stage === 'pending_email' && !payer.emailVerified)
    logger?.warn('Payment from a pending_email account; signup grant not released', { userId, reason });
  return userService.unlockSignupGrant(userId, reason, {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason: ledgerReason,
    validators: reason === 'subscription' ? { subscription: emailVerified } : { credit_purchase: emailVerified },
  });
}

/**
 * Releases the whole remaining signup grant once the user has paid a subscription invoice. Replays and
 * later invoices are no-ops: the remainder is already released and the ledger id is unique.
 */
export const unlockSignupGrantFromSubscription = (userId: string, logger?: UnlockLogger) =>
  unlockSignupGrantFromPayment(userId, 'subscription', 'Subscribed to a paid plan', logger);
