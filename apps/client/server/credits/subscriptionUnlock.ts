import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

/**
 * Releases the whole remaining signup grant once the user has paid a subscription invoice. Replays and
 * later invoices are no-ops: the remainder is already released and the ledger id is unique.
 */
export async function unlockSignupGrantFromSubscription(
  userId: string,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
) {
  const payer = await userRepository.findById(userId);
  // The payment event is not retried, so an unverified payer stays at the tranche until a later unlock.
  if (payer?.signupGrant?.stage === 'pending_email' && !payer.emailVerified)
    logger?.warn('Paid invoice for a pending_email account; signup grant not released', { userId });
  return userService.unlockSignupGrant(userId, 'subscription', {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason: 'Subscribed to a paid plan',
    validators: { subscription: async user => user.emailVerified },
  });
}
