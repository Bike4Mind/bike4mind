import { adminSettingsRepository, paymentAttemptRepository, userRepository } from '@bike4mind/database';
import type { PaymentAttempt, PaymentAttemptKind } from '@bike4mind/database';
import { escapeSlackText, type INetworkMeta } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { hashSignupNetwork } from '@bike4mind/server-utils/auth/signupNetworkSignals';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { adminOwnerSlackRef } from '@server/integrations/slack/subscriptionLifecycle';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import type Stripe from 'stripe';

const MINUTE_MS = 60_000;

/**
 * Payment risk alerting. Two layers, both alert-only (nothing is blocked or refunded here):
 * - Stripe's own risk events (early fraud warnings, reviews, Radar blocks) are forwarded to LiveOps.
 * - Every card payment is recorded as a PaymentAttempt and checked for app-side signals Stripe
 *   cannot see: a young account, one card on several accounts, several cards from one account or
 *   network, a hosting/VPN network. Thresholds are admin settings (settings.ts, paymentRisk*).
 * Never throws into the Stripe webhook: a failed alert must not fail a delivery whose money landed.
 */

export type PaymentRiskThresholds = {
  enabled: boolean;
  youngAccountMinutes: number;
  maxAccountsPerCard: number;
  maxCardsPerWindow: number;
  cardWindowMinutes: number;
  flagHostingNetwork: boolean;
};

export type PaymentRiskSignal =
  | { type: 'youngAccount'; accountAgeMinutes: number }
  | { type: 'sharedCard'; accounts: number }
  | { type: 'manyCardsPerAccount'; cards: number }
  | { type: 'manyCardsPerNetwork'; cards: number }
  | { type: 'hostingNetwork' }
  | { type: 'radarRisk'; riskLevel: string };

export function readPaymentRiskThresholds(settings: Record<string, string>): PaymentRiskThresholds {
  return {
    enabled: getSettingsValue('paymentRiskAlertsEnabled', settings, true),
    youngAccountMinutes: getSettingsValue('paymentRiskYoungAccountMinutes', settings, 60),
    maxAccountsPerCard: getSettingsValue('paymentRiskMaxAccountsPerCard', settings, 1),
    maxCardsPerWindow: getSettingsValue('paymentRiskMaxCardsPerWindow', settings, 1),
    cardWindowMinutes: getSettingsValue('paymentRiskCardWindowMinutes', settings, 60),
    flagHostingNetwork: getSettingsValue('paymentRiskFlagHostingNetwork', settings, true),
  };
}

/** Radar levels worth a human look on a payment that otherwise went through. */
const ALERTING_RISK_LEVELS = new Set(['elevated', 'highest']);

/**
 * The signals one attempt trips. A 0 threshold turns its check off, and an unknown (null) count
 * never trips a check: a truncated scan is not evidence. A failed attempt trips only the card
 * counts: a young or hosted account failing to pay is noise, and a Radar block on it already
 * alerts through alertStripeRiskEvent.
 */
export function evaluatePaymentRiskSignals(input: {
  attempt: Pick<PaymentAttempt, 'outcome' | 'hostingNetwork' | 'riskLevel'>;
  accountCreatedAt: Date | null;
  now: Date;
  counts: { accountsForCard: number | null; userCards: number | null; networkCards: number | null };
  thresholds: PaymentRiskThresholds;
}): PaymentRiskSignal[] {
  const { attempt, accountCreatedAt, now, counts, thresholds } = input;
  const signals: PaymentRiskSignal[] = [];
  const paid = attempt.outcome === 'succeeded';

  if (paid && thresholds.youngAccountMinutes > 0 && accountCreatedAt) {
    const accountAgeMinutes = Math.floor((now.getTime() - accountCreatedAt.getTime()) / MINUTE_MS);
    if (accountAgeMinutes < thresholds.youngAccountMinutes) signals.push({ type: 'youngAccount', accountAgeMinutes });
  }
  if (thresholds.maxAccountsPerCard > 0 && (counts.accountsForCard ?? 0) > thresholds.maxAccountsPerCard) {
    signals.push({ type: 'sharedCard', accounts: counts.accountsForCard! });
  }
  if (thresholds.maxCardsPerWindow > 0) {
    if ((counts.userCards ?? 0) > thresholds.maxCardsPerWindow) {
      signals.push({ type: 'manyCardsPerAccount', cards: counts.userCards! });
    }
    if ((counts.networkCards ?? 0) > thresholds.maxCardsPerWindow) {
      signals.push({ type: 'manyCardsPerNetwork', cards: counts.networkCards! });
    }
  }
  if (paid && thresholds.flagHostingNetwork && attempt.hostingNetwork === true)
    signals.push({ type: 'hostingNetwork' });
  if (paid && attempt.riskLevel && ALERTING_RISK_LEVELS.has(attempt.riskLevel)) {
    signals.push({ type: 'radarRisk', riskLevel: attempt.riskLevel });
  }
  return signals;
}

export function formatAmount(amountMinor: number | null, currency: string | null): string {
  if (amountMinor === null || !currency) return 'unknown';
  return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function describeSignal(signal: PaymentRiskSignal, thresholds: PaymentRiskThresholds): string {
  switch (signal.type) {
    case 'youngAccount':
      return `account is ${signal.accountAgeMinutes} min old`;
    case 'sharedCard':
      return `card has paid on ${signal.accounts} accounts`;
    case 'manyCardsPerAccount':
      return `${signal.cards} cards tried by this account in ${thresholds.cardWindowMinutes} min`;
    case 'manyCardsPerNetwork':
      return `${signal.cards} cards tried from this network in ${thresholds.cardWindowMinutes} min`;
    case 'hostingNetwork':
      return 'started from a hosting/VPN network';
    case 'radarRisk':
      return `Radar risk ${signal.riskLevel}`;
  }
}

export function formatPaymentRiskAlert(
  attempt: PaymentAttempt,
  signals: PaymentRiskSignal[],
  thresholds: PaymentRiskThresholds
): string {
  return [
    `:rotating_light: *Payment risk: ${attempt.kind} payment ${attempt.outcome}*`,
    `*User:* ${adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: attempt.userId })}`,
    `*Payment:* \`${escapeSlackText(attempt.paymentIntentId)}\``,
    `*Amount:* ${formatAmount(attempt.amount, attempt.currency)}`,
    `*Radar risk:* ${attempt.riskLevel ?? 'not reported'}`,
    `*Signals:* ${signals.map(signal => describeSignal(signal, thresholds)).join('; ')}`,
  ].join('\n');
}

const idOf = (ref: string | { id: string } | null | undefined): string | null =>
  typeof ref === 'string' ? ref : (ref?.id ?? null);

export type ChargeRisk = {
  chargeId: string;
  cardFingerprint: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  outcomeType: string | null;
  outcomeReason: string | null;
};

export function chargeRiskOf(charge: Stripe.Charge): ChargeRisk {
  return {
    chargeId: charge.id,
    cardFingerprint: charge.payment_method_details?.card?.fingerprint ?? null,
    riskLevel: charge.outcome?.risk_level ?? null,
    riskScore: charge.outcome?.risk_score ?? null,
    outcomeType: charge.outcome?.type ?? null,
    outcomeReason: charge.outcome?.reason ?? null,
  };
}

async function retrieveChargeRisk(chargeRef: string | Stripe.Charge | null | undefined): Promise<ChargeRisk | null> {
  if (!chargeRef) return null;
  const charge = typeof chargeRef === 'string' ? await stripe.charges.retrieve(chargeRef) : chargeRef;
  return chargeRiskOf(charge);
}

/** Hashed network and hosting flag for a payment started from this request; see PaymentAttemptModel. */
export function paymentNetworkOf(network: Pick<INetworkMeta, 'ip' | 'isDatacenter' | 'wafAnonIp'>): {
  ipHash: string | null;
  hostingNetwork: boolean | null;
} {
  const flags = [network.isDatacenter, network.wafAnonIp ?? null];
  const hostingNetwork = flags.includes(true) ? true : flags.includes(false) ? false : null;
  return { ipHash: hashSignupNetwork(network.ip).ipHash, hostingNetwork };
}

/** Called by start-payment; best-effort, so a failed write never blocks a purchase. */
export async function recordPaymentStart(
  input: { paymentIntentId: string; userId: string; amount: number; currency: string; network: INetworkMeta },
  logger: Logger
): Promise<void> {
  try {
    await paymentAttemptRepository.recordStart({
      paymentIntentId: input.paymentIntentId,
      userId: input.userId,
      kind: 'credits',
      amount: input.amount,
      currency: input.currency,
      ...paymentNetworkOf(input.network),
    });
  } catch (error) {
    logger.error('[PaymentRisk] failed to record payment start', {
      paymentIntentId: input.paymentIntentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Records a Stripe-reported payment outcome and posts one LiveOps alert when it trips any signal.
 * `chargeRef` is the intent's latest (or failing) charge, read for the card fingerprint and Radar
 * outcome. Never throws.
 */
export async function screenPaymentOutcome(
  input: {
    paymentIntentId: string;
    userId: string;
    kind: PaymentAttemptKind;
    amount: number | null;
    currency: string | null;
    outcome: 'succeeded' | 'failed';
    chargeRef: string | Stripe.Charge | null | undefined;
    /** For a failed confirmation the charge may be missing; the error's payment method still has the card. */
    fallbackCardFingerprint?: string | null;
  },
  logger: Logger,
  now: Date = new Date()
): Promise<void> {
  try {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const thresholds = readPaymentRiskThresholds(settings);
    if (!thresholds.enabled) return;

    const [risk, user] = await Promise.all([
      retrieveChargeRisk(input.chargeRef),
      userRepository.findById(input.userId),
    ]);
    const cardFingerprint = risk?.cardFingerprint ?? input.fallbackCardFingerprint ?? null;
    const signupMeta = user?.signupMeta;
    // Checkout subscriptions never pass start-payment, so the signup network stands in for it.
    const signupHosting = signupMeta
      ? paymentNetworkOf({ ip: null, isDatacenter: signupMeta.isDatacenter, wafAnonIp: signupMeta.wafAnonIp })
          .hostingNetwork
      : null;

    const attempt = await paymentAttemptRepository.recordOutcome({
      paymentIntentId: input.paymentIntentId,
      userId: input.userId,
      kind: input.kind,
      amount: input.amount,
      currency: input.currency,
      outcome: input.outcome,
      cardFingerprint,
      riskLevel: risk?.riskLevel ?? null,
      hostingNetwork: signupHosting,
    });

    const since = new Date(now.getTime() - thresholds.cardWindowMinutes * MINUTE_MS);
    const [accountsForCard, recentCards] = await Promise.all([
      cardFingerprint ? paymentAttemptRepository.countAccountsForCard(cardFingerprint) : null,
      paymentAttemptRepository.countRecentCards({ userId: attempt.userId, ipHash: attempt.ipHash, since }),
    ]);

    const signals = evaluatePaymentRiskSignals({
      attempt,
      accountCreatedAt: user?.createdAt ? new Date(user.createdAt) : null,
      now,
      counts: { accountsForCard, ...recentCards },
      thresholds,
    });
    logger.info('[PaymentRisk] screened payment', {
      paymentIntentId: attempt.paymentIntentId,
      userId: attempt.userId,
      outcome: attempt.outcome,
      signals: signals.map(signal => signal.type),
    });
    if (signals.length === 0) return;

    await postMessageToSlack(formatPaymentRiskAlert(attempt, signals, thresholds));
  } catch (error) {
    logger.error('[PaymentRisk] screening failed', {
      paymentIntentId: input.paymentIntentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Stripe objects that carry risk, normalized for one alert. */
export type StripeRiskEvent = {
  title: string;
  chargeRef: string | Stripe.Charge | null | undefined;
  paymentIntentId: string | null;
  detail: string | null;
};

/**
 * Maps a Stripe webhook event to a risk alert, or null when the event is not one. A failed payment
 * intent alerts only when Radar blocked it or rated it elevated/highest; ordinary declines do not.
 */
export function stripeRiskEventOf(event: Stripe.Event): StripeRiskEvent | null {
  switch (event.type) {
    case 'radar.early_fraud_warning.created': {
      const warning = event.data.object;
      return {
        title: 'Stripe early fraud warning',
        chargeRef: warning.charge,
        paymentIntentId: idOf(warning.payment_intent),
        detail: `fraud type ${warning.fraud_type}${warning.actionable ? ', actionable (refund to avoid a dispute)' : ''}`,
      };
    }
    case 'review.opened': {
      const review = event.data.object;
      return {
        title: 'Stripe Radar review opened',
        chargeRef: review.charge,
        paymentIntentId: idOf(review.payment_intent),
        detail: `reason ${review.reason}`,
      };
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      return {
        title: 'Stripe payment failed',
        chargeRef: intent.last_payment_error?.charge,
        paymentIntentId: intent.id,
        detail: intent.last_payment_error?.decline_code ? `decline ${intent.last_payment_error.decline_code}` : null,
      };
    }
    default:
      return null;
  }
}

export function formatStripeRiskAlert(input: {
  title: string;
  userId: string | null;
  paymentIntentId: string | null;
  risk: ChargeRisk;
  amountMinor: number | null;
  currency: string | null;
  detail: string | null;
}): string {
  const { risk } = input;
  const user = input.userId
    ? adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: input.userId })
    : 'not found';
  const ids = [input.paymentIntentId, risk.chargeId].filter(Boolean).map(id => `\`${escapeSlackText(id!)}\``);
  const outcome = [risk.outcomeType, risk.outcomeReason].filter(Boolean).join(' / ');
  return [
    `:rotating_light: *${input.title}*`,
    `*User:* ${user}`,
    `*Payment:* ${ids.join(' / ')}`,
    `*Amount:* ${formatAmount(input.amountMinor, input.currency)}`,
    `*Radar risk:* ${risk.riskLevel ?? 'not reported'}${risk.riskScore !== null ? ` (score ${risk.riskScore})` : ''}`,
    ...(outcome ? [`*Outcome:* ${escapeSlackText(outcome)}`] : []),
    ...(input.detail ? [`*Detail:* ${escapeSlackText(input.detail)}`] : []),
  ].join('\n');
}

/** A blocked or high-risk charge is worth an alert; a plain decline is not. */
export function isRiskyCharge(risk: ChargeRisk): boolean {
  return risk.outcomeType === 'blocked' || (risk.riskLevel !== null && ALERTING_RISK_LEVELS.has(risk.riskLevel));
}

/**
 * Forwards a Stripe risk event to LiveOps. The purchaser is resolved from the charge's customer,
 * then from the intent metadata's userId. Never throws.
 */
export async function alertStripeRiskEvent(event: Stripe.Event, logger: Logger): Promise<void> {
  const riskEvent = stripeRiskEventOf(event);
  if (!riskEvent) return;
  try {
    const chargeRef = riskEvent.chargeRef;
    if (!chargeRef) {
      logger.warn('[PaymentRisk] risk event without a charge', { event: event.type });
      return;
    }
    const charge = typeof chargeRef === 'string' ? await stripe.charges.retrieve(chargeRef) : chargeRef;
    const risk = chargeRiskOf(charge);
    if (event.type === 'payment_intent.payment_failed' && !isRiskyCharge(risk)) return;

    const customerId = idOf(charge.customer);
    const customerUser = customerId ? await userRepository.findByStripeCustomerId(customerId) : null;
    const userId = customerUser?.id ?? charge.metadata?.userId ?? null;

    await postMessageToSlack(
      formatStripeRiskAlert({
        title: riskEvent.title,
        userId,
        paymentIntentId: riskEvent.paymentIntentId,
        risk,
        amountMinor: charge.amount,
        currency: charge.currency,
        detail: riskEvent.detail,
      })
    );
  } catch (error) {
    logger.error('[PaymentRisk] failed to forward Stripe risk event', {
      event: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The Radar risk line for an alert that already exists (disputes). Never throws; null when unknown. */
export async function radarRiskLine(chargeRef: string | Stripe.Charge | null | undefined): Promise<string | null> {
  try {
    const risk = await retrieveChargeRisk(chargeRef);
    if (!risk?.riskLevel) return null;
    return `*Radar risk:* ${risk.riskLevel}${risk.riskScore !== null ? ` (score ${risk.riskScore})` : ''}`;
  } catch {
    return null;
  }
}
