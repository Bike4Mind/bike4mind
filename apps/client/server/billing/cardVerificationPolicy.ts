import { z } from 'zod';
import type Stripe from 'stripe';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const cardDefensePolicySchema = z.object({
  accountId: z.string().min(1),
  validUntil: z.string().datetime(),
  setupRadarEnabled: z.literal(true),
  highRiskBlockEnabled: z.literal(true),
  allowRulesReviewed: z.literal(true),
  alertsReady: z.literal(true),
  attemptsWindowMs: positive,
  accountAttempts: positive,
  ipAttempts: positive,
  asnAttempts: positive,
  accountDailyFailures: positive,
  ipDailyFailures: positive,
  failureSpikeCount: positive,
  failureSpikeWindowMs: positive,
});

export type CardDefensePolicy = z.infer<typeof cardDefensePolicySchema>;

export function parseCardDefensePolicy(raw: string | undefined, now = Date.now()): CardDefensePolicy | null {
  try {
    const parsed = cardDefensePolicySchema.parse(JSON.parse(raw ?? 'null'));
    return Date.parse(parsed.validUntil) > now ? parsed : null;
  } catch {
    return null;
  }
}

/** SetupIntents have no charge-style risk outcome. Radar must block risk at Stripe, and 3DS must authenticate. */
export function authenticatedSetupAttempt(intent: Stripe.SetupIntent, attempt: Stripe.SetupAttempt): boolean {
  const id = (value: string | { id: string } | null) => (typeof value === 'string' ? value : value?.id);
  return !!(
    intent.status === 'succeeded' &&
    !intent.last_setup_error &&
    attempt.id === id(intent.latest_attempt) &&
    id(attempt.setup_intent) === intent.id &&
    id(attempt.customer) === id(intent.customer) &&
    id(attempt.payment_method) === id(intent.payment_method) &&
    attempt.livemode === intent.livemode &&
    attempt.status === 'succeeded' &&
    !attempt.setup_error &&
    attempt.payment_method_details.type === 'card' &&
    attempt.payment_method_details.card?.three_d_secure?.result === 'authenticated'
  );
}
