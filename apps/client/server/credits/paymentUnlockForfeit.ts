import { CreditHolderType, type SignupUnlockForfeitCause } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  paymentAttemptRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@bike4mind/server-utils/auth/signupProtection';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { alertFraudBlock } from '@server/billing/fraudBlockAlert';
import { reopenSettledPaymentApproval } from '@server/security/riskReviewAutoApproval';

type ForfeitLogger = { info: (message: string, meta?: Record<string, unknown>) => void };

/**
 * Records the dispute, refund or early fraud warning on the account (paymentRiskEventAt, which keeps
 * it out of automatic risk review approval), cancels its held payment signup unlock, and reopens a
 * risk review approved on settled payment evidence (riskReviewAutoApproval.ts).
 * Throws on failure so the webhook is retried; a replay is a no-op.
 */
export async function forfeitSignupUnlock(userId: string, cause: SignupUnlockForfeitCause, logger: ForfeitLogger) {
  // Written before the reopen below, so an approval racing this event is either refused by the write filter or reopened.
  await userRepository.recordPaymentRiskEvent(userId, new Date());
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
  if (await reopenSettledPaymentApproval(userId, cause)) {
    logger.info(`Settled-payment risk review approval reopened after a payment ${cause}`, { userId });
  }
  return result;
}

type StripeRef = string | { id: string } | null | undefined;
type ChargeRef = { customer?: StripeRef; payment_intent?: StripeRef };

const refId = (ref: StripeRef) => (typeof ref === 'string' ? ref : ref?.id);

/** The user a credit pack purchase row credited; an organization's purchase has no individual buyer. */
async function findCreditPackBuyerId(paymentIntentId: string) {
  const purchase = await creditTransactionRepository.findByPaymentIntentId(paymentIntentId);
  return purchase?.ownerType === CreditHolderType.User && purchase.ownerId ? String(purchase.ownerId) : null;
}

/**
 * The individual account billed for a charge: by Stripe customer, else, when the customer resolves to
 * no user, the account that started its payment intent, else the buyer of the credit pack it paid for.
 * An organization's charge has no individual payer, so it never falls back to the member who started it.
 */
async function findChargePayerId(charge: ChargeRef) {
  const customerId = refId(charge.customer);
  const byCustomer = customerId ? await userRepository.findByStripeCustomerId(customerId) : null;
  if (byCustomer) return byCustomer.id;
  if (customerId && (await organizationRepository.findByStripeCustomerId(customerId))) return null;
  const paymentIntentId = refId(charge.payment_intent);
  if (!paymentIntentId) return null;
  const attemptUserId = await paymentAttemptRepository.findUserId(paymentIntentId);
  const attemptUser = attemptUserId ? await userRepository.findById(attemptUserId) : null;
  return attemptUser?.id ?? (await findCreditPackBuyerId(paymentIntentId));
}

/**
 * charge.refunded: the charge's payer, including a subscription charge with no credit purchase row,
 * or else the buyer of the refunded credit pack.
 */
export async function forfeitHeldUnlockForRefund(charge: ChargeRef, logger: ForfeitLogger) {
  const userId = await findChargePayerId(charge);
  if (userId) await forfeitSignupUnlock(userId, 'refund', logger);
}

/** radar.early_fraud_warning.created: resolves the warned charge's payer the same way as a refund. */
export async function forfeitHeldUnlockForFraudWarning(
  warning: { id: string; charge: string | { id: string } },
  logger: ForfeitLogger & { warn: (message: string) => void }
) {
  const chargeId = typeof warning.charge === 'string' ? warning.charge : warning.charge.id;
  const userId = await findChargePayerId(await stripe.charges.retrieve(chargeId));
  if (userId) await forfeitSignupUnlock(userId, 'fraud_warning', logger);
  else logger.warn(`Could not find user for early fraud warning ${warning.id}`);
}
