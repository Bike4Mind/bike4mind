import type { SignupUnlockForfeitCause } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

type ForfeitLogger = { info: (message: string, meta?: Record<string, unknown>) => void };

/**
 * Cancels the account's held payment signup unlock after a dispute, refund or early fraud warning.
 * Throws on failure so the webhook is retried; a replay is a no-op.
 */
export async function forfeitSignupUnlock(userId: string, cause: SignupUnlockForfeitCause, logger: ForfeitLogger) {
  const result = await userService.forfeitPaymentUnlock(userId, cause, {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
  });
  if (result.outcome === 'cancelled')
    logger.info(`Held signup unlock bonus cancelled after a payment ${cause}`, { userId });
  return result;
}

/** The individual account billed under a Stripe customer; organization customers have no signup grant. */
export async function findUserByStripeCustomer(customer: string | { id: string } | null | undefined) {
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  return customerId ? userRepository.findByStripeCustomerId(customerId) : null;
}
