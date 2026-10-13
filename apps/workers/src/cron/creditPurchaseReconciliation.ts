/**
 * Credit Purchase Reconciliation
 *
 * Alerts on one-off credit purchases that Stripe charged but the ledger never granted. Lists this
 * stage's succeeded credit payment intents (stamped with metadata.environment and metadata.credits
 * by pages/api/stripe/start-payment.ts) and matches each against the purchase CreditTransaction the
 * payment_intent.succeeded webhook records under stripePaymentIntentId.
 *
 * A row alone does not prove the credits landed: addCredits commits the row before the balance
 * $inc. apps/client/server/billing/grantCreditPurchase.ts now wraps both in one transaction, but rows
 * written before that, or by any purchase grant that bypasses it, can hold no balance behind them.
 * The $inc stamps the user's lastCreditsPurchasedAt in the same update, so a stamp older than the
 * row (beyond a small tolerance) means the increment never ran. A later purchase or admin grant
 * overwrites the stamp, so this can miss a failed increment; it is tuned not to flag an applied one.
 * A row repaired by packages/scripts/src/auditPartialCreditPurchases.ts carries metadata.balanceBackfilledAt
 * (that script does not stamp the user), so it is treated as applied.
 *
 * Read-only against Stripe and the ledger: it never grants, so a rerun only repeats the alert, and
 * an unresolved purchase is reported on every run whose window still covers it.
 *
 * Subscription invoices are out of scope: their grants are keyed by an invoice-derived idempotency
 * key and are legitimately skipped by the re-subscribe cooldown (lib/userSubscriptions/serverUtils.ts),
 * so a missing row there is not a reliable signal.
 *
 * Schedule: daily at 7am UTC
 * Enabled: production + dev
 */

import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { CreditHolderType } from '@bike4mind/common';
import { connectDB, creditTransactionRepository, userRepository } from '@bike4mind/database';
import { isStripeConfigured, stripe } from '@server/integrations/stripe/stripe';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { emitMetric } from '@server/utils/cloudwatch';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

const CLOUDWATCH_NAMESPACE = 'Lumina5/CreditPurchases';

// Two days so a missed run is still covered; the grace skips intents whose webhook may still be
// in flight or retrying.
export const LOOKBACK_MS = 48 * 60 * 60 * 1000;
export const GRACE_MS = 30 * 60 * 1000;
const PAGE_SIZE = 100;
export const MAX_PAGES = 20;
const MAX_ALERT_LINES = 20;
// Slack for the row and the stamp being written by separate statements.
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

// Derived rather than imported: the stripe package is a dependency of apps/client, not of workers.
type PaymentIntent = Awaited<ReturnType<typeof stripe.paymentIntents.list>>['data'][number];

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

export type UngrantedReason = 'no_transaction' | 'balance_not_applied' | 'owner_missing';

export interface UngrantedPurchase {
  paymentIntentId: string;
  reason: UngrantedReason;
  userId?: string;
  /** Minor units (cents). */
  amount: number;
  currency: string;
  credits: number;
  createdAt: string;
}

export interface CreditPurchaseReconciliationResult {
  checked: number;
  ungranted: UngrantedPurchase[];
  /** True when MAX_PAGES was hit before Stripe ran out of intents in the window. */
  truncated: boolean;
}

function isStageCreditPurchase(intent: PaymentIntent, stage: string): boolean {
  return (
    intent.status === 'succeeded' && intent.metadata?.environment === stage && Number(intent.metadata?.credits) >= 1
  );
}

const REASON_LABELS: Record<UngrantedReason, string> = {
  no_transaction: 'no purchase transaction',
  balance_not_applied: 'transaction recorded but balance never credited',
  owner_missing: 'transaction recorded but owner user no longer exists',
};

// The webhook only grants purchases to users, so other owner types are not balance-checked.
async function findUngrantedReason(intentId: string): Promise<UngrantedReason | null> {
  const tx = await creditTransactionRepository.findByPaymentIntentId(intentId);
  if (!tx) return 'no_transaction';
  if (tx.ownerType !== CreditHolderType.User) return null;
  if (tx.metadata?.balanceBackfilledAt) return null;
  const owner = await userRepository.findById(tx.ownerId);
  if (!owner) return 'owner_missing';
  const appliedAt = owner.lastCreditsPurchasedAt;
  const applied = appliedAt && appliedAt.getTime() >= tx.createdAt.getTime() - CLOCK_SKEW_TOLERANCE_MS;
  return applied ? null : 'balance_not_applied';
}

function formatAlert(stage: string, result: CreditPurchaseReconciliationResult): string {
  const lines = result.ungranted
    .slice(0, MAX_ALERT_LINES)
    .map(
      p =>
        `- ${p.paymentIntentId} (${REASON_LABELS[p.reason]}): $${(p.amount / 100).toFixed(2)} ${p.currency.toUpperCase()}, ${p.credits} credits, ` +
        `user ${p.userId ?? 'unknown'}, paid ${p.createdAt}`
    );
  const more = result.ungranted.length - lines.length;
  return [
    `:warning: *Credit purchases paid but not granted* (${stage}): ${result.ungranted.length} of ${result.checked} ` +
      `succeeded intent(s) have no credits behind them.`,
    ...lines,
    ...(more > 0 ? [`...and ${more} more (see the CreditPurchaseReconciliation logs).`] : []),
    ...(result.truncated ? ['Scan truncated at the page cap; older intents in the window were not checked.'] : []),
    ...(result.ungranted.some(p => p.reason === 'no_transaction')
      ? [
          'No purchase transaction: verify in Stripe, then grant manually. The webhook logs each intent under [CreditPurchase].',
        ]
      : []),
    ...(result.ungranted.some(p => p.reason === 'balance_not_applied')
      ? [
          'Balance never credited: check the user balance and credit ledger first, then add the credits with an ' +
            'admin credit adjustment, which clears this alert on the next run. Any positive adjustment clears it ' +
            'for every line listed for that user, so credit the full amount for each. Do not re-grant the purchase ' +
            '(the row exists, so a redelivery will not grant).',
        ]
      : []),
    ...(result.ungranted.some(p => p.reason === 'owner_missing')
      ? ['Owner missing: the purchasing user was deleted; there is no balance to credit, so refund or review manually.']
      : []),
  ].join('\n');
}

export async function runCreditPurchaseReconciliation(
  logger: Logger = new Logger(),
  now: Date = new Date()
): Promise<CreditPurchaseReconciliationResult> {
  const stage = Resource.App.stage;
  const created = {
    gte: Math.floor((now.getTime() - LOOKBACK_MS) / 1000),
    lte: Math.floor((now.getTime() - GRACE_MS) / 1000),
  };

  const result: CreditPurchaseReconciliationResult = { checked: 0, ungranted: [], truncated: false };
  let startingAfter: string | undefined;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      result.truncated = true;
      logger.warn(`[CreditPurchaseReconciliation] Stopped at ${MAX_PAGES} pages; window not fully scanned`);
      break;
    }
    const { data, has_more } = await stripe.paymentIntents.list({
      created,
      limit: PAGE_SIZE,
      ...(startingAfter && { starting_after: startingAfter }),
    });

    for (const intent of data) {
      if (!isStageCreditPurchase(intent, stage)) continue;
      result.checked++;
      const reason = await findUngrantedReason(intent.id);
      if (!reason) continue;
      result.ungranted.push({
        paymentIntentId: intent.id,
        reason,
        userId: intent.metadata?.userId,
        amount: intent.amount,
        currency: intent.currency,
        credits: Number(intent.metadata.credits),
        createdAt: new Date(intent.created * 1000).toISOString(),
      });
    }

    if (!has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }

  for (const purchase of result.ungranted) {
    logger.error('[CreditPurchaseReconciliation] Succeeded credit purchase has no grant', purchase);
  }
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'UngrantedPurchases',
    result.ungranted.length,
    { Stage: stage },
    StandardUnit.Count
  );
  if (result.ungranted.length > 0) {
    await postMessageToSlack(formatAlert(stage, result));
  }

  logger.log(
    `[CreditPurchaseReconciliation] Checked ${result.checked} succeeded purchase(s): ` +
      `${result.ungranted.length} ungranted${result.truncated ? ' (truncated)' : ''}`
  );
  return result;
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  if (!isStripeConfigured()) {
    logger.log('[CreditPurchaseReconciliation] Stripe not configured, skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const { checked, ungranted, truncated } = await runCreditPurchaseReconciliation(logger);
  return { statusCode: 200, body: JSON.stringify({ checked, ungranted: ungranted.length, truncated }) };
}
