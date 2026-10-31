import {
  adminSettingsRepository,
  creditTransactionRepository,
  paymentRiskActionRepository,
  userRepository,
} from '@bike4mind/database';
import { CreditHolderType, escapeSlackText } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import {
  SubscriptionOwnerType,
  SubscriptionSource,
  TERMINAL_SUBSCRIPTION_STATUSES,
  resolveSubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { voidOpenSubscriptionInvoices } from '@server/integrations/stripe/dunning';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { adminOwnerSlackRef } from '@server/integrations/slack/subscriptionLifecycle';
import { subscriptionRepository } from '@server/models/Subscription';
import { alertStripeRiskEvent, chargeRiskOf, formatAmount } from '@server/billing/paymentRisk';
import { clawbackRefundCredits } from '@server/billing/refundClawback';
import { lockAccountForPaymentRisk, propagateAccountRisk } from '@server/billing/linkedAccounts';
import type Stripe from 'stripe';

/**
 * The automatic response to a Stripe early fraud warning: the issuer has told Stripe the charge
 * was fraudulent, and a dispute (with its fee and its mark on the dispute ratio) usually follows.
 * The account is locked the way a dispute locks it, subscriptions on the same card are cancelled,
 * linked accounts are handled by propagateAccountRisk, and any signup credits its subscription
 * unlocked are clawed back; then the charge is refunded, which ends the dispute, and the credits it
 * bought are clawed back. Off (paymentRiskAutoRefundEnabled), the warning is only forwarded to LiveOps.
 *
 * Idempotent on the warning id: a completed response is skipped, the refund carries a Stripe
 * idempotency key, the purchase clawback is keyed by the refund id, and the steps that must not
 * repeat (signup clawback, alert) are claimed in PaymentRiskAction. Errors propagate so Stripe
 * retries the delivery; a refund Stripe refuses is reported in the alert first, so the account is
 * already contained when the delivery fails.
 */

export type EarlyFraudWarningSettings = { autoAct: boolean; minUnspentPercent: number };

export function readEarlyFraudWarningSettings(settings: Record<string, string>): EarlyFraudWarningSettings {
  return {
    autoAct: getSettingsValue('paymentRiskAutoRefundEnabled', settings, true),
    minUnspentPercent: getSettingsValue('paymentRiskAutoRefundMinUnspentPercent', settings, 0),
  };
}

/** Percent of a purchase's credits the balance still covers; null when the purchase is unknown. */
export function unspentPercent(balance: number, purchasedCredits: number | null): number | null {
  if (!purchasedCredits || purchasedCredits <= 0) return null;
  return Math.round((Math.max(0, Math.min(balance, purchasedCredits)) / purchasedCredits) * 100);
}

/** A 0 threshold always refunds, and so does a charge whose purchase is unknown (a subscription). */
export function shouldRefund(unspent: number | null, minUnspentPercent: number): boolean {
  return minUnspentPercent <= 0 || unspent === null || unspent >= minUnspentPercent;
}

export type RefundResult =
  | { status: 'refunded'; refundId: string; amount: number; currency: string; clawedBackCredits: number }
  | { status: 'alreadyRefunded' }
  | { status: 'belowThreshold'; unspent: number; threshold: number }
  | { status: 'failed'; reason: string };

export type FraudWarningResponse = {
  refund: RefundResult;
  signupClawback: number;
  locked: boolean;
  deactivatedKeys: boolean;
  cancelledSubscriptions: string[];
  linked: { locked: string[]; review: string[] };
};

const idOf = (ref: string | { id: string } | null | undefined): string | null =>
  typeof ref === 'string' ? ref : (ref?.id ?? null);

async function refundCharge(input: {
  warningId: string;
  charge: Stripe.Charge;
  paymentIntentId: string | null;
  userId: string;
  purchasedCredits: number | null;
}): Promise<RefundResult & { status: 'refunded' | 'alreadyRefunded' }> {
  const { warningId, charge, paymentIntentId, userId, purchasedCredits } = input;
  const remaining = charge.amount - charge.amount_refunded;
  if (charge.refunded || remaining <= 0) return { status: 'alreadyRefunded' };

  const refund = await stripe.refunds.create(
    { charge: charge.id, amount: remaining, reason: 'fraudulent', metadata: { earlyFraudWarningId: warningId } },
    { idempotencyKey: `efw-refund:${warningId}` }
  );
  // Clawed back now rather than on the charge.refunded webhook; that webhook then finds the refund
  // id taken and skips.
  const clawback =
    purchasedCredits && paymentIntentId
      ? await clawbackRefundCredits({
          userId,
          paymentIntentId,
          purchasedCredits,
          chargeAmount: charge.amount_captured || charge.amount,
          refund: { id: refund.id, amount: refund.amount },
        })
      : null;
  return {
    status: 'refunded',
    refundId: refund.id,
    amount: refund.amount,
    currency: refund.currency,
    clawedBackCredits: clawback?.credits ?? 0,
  };
}

/** Stripe's error code (e.g. charge_disputed, balance_insufficient), else the message. */
function refundFailureReason(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A refund Stripe refuses becomes a reported result; the caller rethrows the error once it has alerted. */
async function attemptRefund(
  input: Parameters<typeof refundCharge>[0]
): Promise<{ refund: RefundResult; refundError: unknown }> {
  try {
    return { refund: await refundCharge(input), refundError: null };
  } catch (error) {
    return { refund: { status: 'failed', reason: refundFailureReason(error) }, refundError: error };
  }
}

/**
 * Takes back the signup credits a subscription payment released, when the warned charge is that
 * kind of payment. Capped at the balance, like the bulk abuse clawback. At most once per warning.
 */
async function clawbackSubscriptionUnlock(key: string, userId: string): Promise<number> {
  const user = await userRepository.findById(userId);
  const grant = user?.signupGrant;
  // unlockedBy is set only once the bonus is paid out; a bonus still held is never clawed back here.
  if (!user || grant?.unlockedBy !== 'subscription' || !grant.unlockCredits) return 0;
  const credits = Math.max(0, Math.min(user.currentCredits ?? 0, grant.unlockCredits));
  if (credits === 0) return 0;
  if (!(await paymentRiskActionRepository.claimStep(key, 'signupClawback', userId))) return 0;

  await creditService.subtractCredits(
    {
      type: 'generic_deduct',
      ownerId: userId,
      ownerType: CreditHolderType.User,
      credits,
      reason: 'abuse_clawback',
      description: 'Signup credits unlocked by a subscription payment that Stripe flagged as fraudulent',
    },
    { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
  );
  return credits;
}

/** Cancels, immediately, the user's Stripe subscriptions paid by this card (all of them when the card is unknown). */
async function cancelSubscriptionsOnCard(userId: string, cardFingerprint: string | null): Promise<string[]> {
  const rows = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(SubscriptionOwnerType.User, userId);
  const cancelled: string[] = [];
  for (const row of rows) {
    if (resolveSubscriptionSource(row) !== SubscriptionSource.Stripe || !row.subscriptionId) continue;
    const live = await stripe.subscriptions.retrieve(row.subscriptionId, { expand: ['default_payment_method'] });
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(live.status)) continue;
    const method = live.default_payment_method;
    const liveFingerprint = typeof method === 'object' && method ? (method.card?.fingerprint ?? null) : null;
    if (cardFingerprint && liveFingerprint && liveFingerprint !== cardFingerprint) continue;

    // invoice_now/prorate default to false, so the cancel mints no invoice; customer.subscription.deleted
    // then closes the local row.
    await stripe.subscriptions.cancel(row.subscriptionId);
    await voidOpenSubscriptionInvoices(row.subscriptionId);
    cancelled.push(row.subscriptionId);
  }
  return cancelled;
}

function describeRefund(refund: RefundResult): string {
  switch (refund.status) {
    case 'refunded':
      return `refunded ${formatAmount(refund.amount, refund.currency)} (\`${escapeSlackText(refund.refundId)}\`), ${refund.clawedBackCredits} credits clawed back`;
    case 'alreadyRefunded':
      return 'already refunded';
    case 'belowThreshold':
      return `not refunded: ${refund.unspent}% of its credits unspent, below the ${refund.threshold}% setting`;
    case 'failed':
      return `*refund failed* (${escapeSlackText(refund.reason)}), Stripe will retry the delivery`;
  }
}

export function formatFraudWarningAlert(input: {
  warning: Pick<Stripe.Radar.EarlyFraudWarning, 'id' | 'fraud_type'>;
  userId: string;
  charge: Stripe.Charge;
  response: FraudWarningResponse;
}): string {
  const { warning, userId, charge, response } = input;
  const risk = chargeRiskOf(charge);
  const done = [
    describeRefund(response.refund),
    ...(response.signupClawback > 0 ? [`${response.signupClawback} unlocked signup credits clawed back`] : []),
    response.locked
      ? `account locked${response.deactivatedKeys ? ', API keys deactivated' : ''}`
      : 'account already locked',
    ...(response.cancelledSubscriptions.length > 0
      ? [`cancelled ${response.cancelledSubscriptions.map(id => `\`${escapeSlackText(id)}\``).join(', ')}`]
      : []),
    ...(response.linked.locked.length > 0 ? [`${response.linked.locked.length} card-linked account(s) locked`] : []),
    ...(response.linked.review.length > 0
      ? [`${response.linked.review.length} network-linked account(s) to review`]
      : []),
  ];
  return [
    ':rotating_light: *Stripe early fraud warning: acted automatically*',
    `*User:* ${adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: userId })}`,
    `*Charge:* \`${escapeSlackText(charge.id)}\` (${formatAmount(charge.amount, charge.currency)})`,
    `*Fraud type:* ${escapeSlackText(warning.fraud_type)}`,
    `*Radar risk:* ${risk.riskLevel ?? 'not reported'}${risk.riskScore !== null ? ` (score ${risk.riskScore})` : ''}`,
    `*Done:* ${done.join('; ')}`,
  ].join('\n');
}

async function resolvePurchaser(
  charge: Stripe.Charge,
  paymentIntentId: string | null
): Promise<{ userId: string; purchasedCredits: number | null } | null> {
  const purchase = paymentIntentId ? await creditTransactionRepository.findByPaymentIntentId(paymentIntentId) : null;
  if (purchase) return { userId: purchase.ownerId, purchasedCredits: purchase.credits };
  const customerId = idOf(charge.customer);
  const customer = customerId ? await userRepository.findByStripeCustomerId(customerId) : null;
  return customer ? { userId: customer.id, purchasedCredits: null } : null;
}

export async function respondToEarlyFraudWarning(
  event: Stripe.RadarEarlyFraudWarningCreatedEvent,
  logger: Logger
): Promise<void> {
  const warning = event.data.object;
  const key = `efw:${warning.id}`;
  const settings = readEarlyFraudWarningSettings(await getSettingsMap({ adminSettings: adminSettingsRepository }));
  if (!settings.autoAct) {
    await alertStripeRiskEvent(event, logger);
    return;
  }
  if (await paymentRiskActionRepository.isCompleted(key)) {
    logger.info('[PaymentRisk] early fraud warning already handled', { warningId: warning.id });
    return;
  }

  const chargeId = idOf(warning.charge);
  if (!chargeId) {
    await alertStripeRiskEvent(event, logger);
    return;
  }
  const charge = await stripe.charges.retrieve(chargeId);
  const paymentIntentId = idOf(warning.payment_intent) ?? idOf(charge.payment_intent);
  const purchaser = await resolvePurchaser(charge, paymentIntentId);
  if (!purchaser) {
    // An org's or another stage's customer: nothing here to act on, so LiveOps gets the plain alert.
    logger.warn('[PaymentRisk] early fraud warning for a charge with no user here', { warningId: warning.id });
    await alertStripeRiskEvent(event, logger);
    await paymentRiskActionRepository.markCompleted(key, null);
    return;
  }
  const { userId, purchasedCredits } = purchaser;
  const user = await userRepository.findById(userId);
  if (!user) throw new Error(`User ${userId} for early fraud warning ${warning.id} not found`);

  // Containment runs before the refund and is safe to repeat: Stripe refuses a refund on exactly
  // the charges that most need it (a dispute already open, a short balance), and that must not
  // leave the account unlocked.
  const unspent = unspentPercent(user.currentCredits ?? 0, purchasedCredits);
  const wasBlocked = Boolean(user.disputePending);
  const { deactivatedKeys } = await lockAccountForPaymentRisk(user);
  const cancelledSubscriptions = await cancelSubscriptionsOnCard(userId, chargeRiskOf(charge).cardFingerprint);
  const linked = await propagateAccountRisk(
    { sourceUserId: userId, trigger: 'early fraud warning', key: `${key}:linked` },
    logger
  );
  // A credit pack never unlocks the signup grant; a subscription payment can.
  const signupClawback = purchasedCredits === null ? await clawbackSubscriptionUnlock(key, userId) : 0;

  const { refund, refundError } = shouldRefund(unspent, settings.minUnspentPercent)
    ? await attemptRefund({ warningId: warning.id, charge, paymentIntentId, userId, purchasedCredits })
    : {
        refund: { status: 'belowThreshold', unspent: unspent!, threshold: settings.minUnspentPercent } as const,
        refundError: null,
      };

  const response: FraudWarningResponse = {
    refund,
    signupClawback,
    locked: !wasBlocked,
    deactivatedKeys,
    cancelledSubscriptions,
    linked,
  };
  logger.info('[PaymentRisk] acted on early fraud warning', {
    warningId: warning.id,
    userId,
    chargeId,
    refund: refund.status,
    signupClawback,
    cancelledSubscriptions,
    linked,
  });
  if (await paymentRiskActionRepository.claimStep(key, 'alert', userId)) {
    await postMessageToSlack(formatFraudWarningAlert({ warning, userId, charge, response }));
  }
  // Left uncompleted so the retried delivery tries the refund again; the alert is already claimed.
  if (refundError !== null) throw refundError;
  await paymentRiskActionRepository.markCompleted(key, userId);
}
