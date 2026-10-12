/**
 * Credit Purchase Reconciliation
 *
 * Alerts on one-off credit purchases that Stripe charged but the ledger never granted. Lists this
 * stage's succeeded credit payment intents (stamped with metadata.environment and metadata.credits
 * by pages/api/stripe/start-payment.ts) and matches each against the purchase CreditTransaction the
 * payment_intent.succeeded webhook records under stripePaymentIntentId.
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
import { connectDB, creditTransactionRepository } from '@bike4mind/database';
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

// Derived rather than imported: the stripe package is a dependency of apps/client, not of workers.
type PaymentIntent = Awaited<ReturnType<typeof stripe.paymentIntents.list>>['data'][number];

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

export interface UngrantedPurchase {
  paymentIntentId: string;
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

function formatAlert(stage: string, result: CreditPurchaseReconciliationResult): string {
  const lines = result.ungranted
    .slice(0, MAX_ALERT_LINES)
    .map(
      p =>
        `- ${p.paymentIntentId}: $${(p.amount / 100).toFixed(2)} ${p.currency.toUpperCase()}, ${p.credits} credits, ` +
        `user ${p.userId ?? 'unknown'}, paid ${p.createdAt}`
    );
  const more = result.ungranted.length - lines.length;
  return [
    `:warning: *Credit purchases paid but not granted* (${stage}): ${result.ungranted.length} of ${result.checked} ` +
      `succeeded intent(s) have no purchase transaction.`,
    ...lines,
    ...(more > 0 ? [`...and ${more} more (see the CreditPurchaseReconciliation logs).`] : []),
    ...(result.truncated ? ['Scan truncated at the page cap; older intents in the window were not checked.'] : []),
    'Verify in Stripe, then grant manually. The webhook logs each intent under [CreditPurchase].',
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
      if (await creditTransactionRepository.findByPaymentIntentId(intent.id)) continue;
      result.ungranted.push({
        paymentIntentId: intent.id,
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
