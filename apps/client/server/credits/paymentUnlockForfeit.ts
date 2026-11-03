import type { SignupUnlockForfeitCause } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { alertFraudBlock } from '@server/billing/fraudBlockAlert';

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
  if (result.outcome === 'cancelled') {
    logger.info(`Held signup unlock bonus cancelled after a payment ${cause}`, { userId });
    await alertFraudBlock({
      kind: 'signupUnlockForfeited',
      userId,
      details: [`*Cause:* payment ${cause.replace(/_/g, ' ')}`],
    });
  }
  return result;
}

type ChargeRef = { customer?: string | { id: string } | null };

/** The individual account billed under a Stripe customer; organization customers have no signup grant. */
async function findUserByStripeCustomer(customer: ChargeRef['customer']) {
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  return customerId ? userRepository.findByStripeCustomerId(customerId) : null;
}

/** charge.refunded: the charge's payer, including a subscription charge with no credit purchase row. */
export async function forfeitHeldUnlockForRefund(charge: ChargeRef, logger: ForfeitLogger) {
  const user = await findUserByStripeCustomer(charge.customer);
  if (user) await forfeitSignupUnlock(user.id, 'refund', logger);
}

/** radar.early_fraud_warning.created: resolves the warned charge's payer. */
export async function forfeitHeldUnlockForFraudWarning(
  warning: { id: string; charge: string | { id: string } },
  logger: ForfeitLogger & { warn: (message: string) => void }
) {
  const chargeId = typeof warning.charge === 'string' ? warning.charge : warning.charge.id;
  const user = await findUserByStripeCustomer((await stripe.charges.retrieve(chargeId)).customer);
  if (user) await forfeitSignupUnlock(user.id, 'fraud_warning', logger);
  else logger.warn(`Could not find user for early fraud warning ${warning.id}`);
}
