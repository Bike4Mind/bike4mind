/**
 * Subscription Reconciliation
 *
 * Records where Subscription rows and organization seats disagree with Stripe, as BillingMismatch
 * findings the admin Subscriptions list shows (Mismatched view, banner, chip) and Sync from Stripe
 * repairs. Mongo only follows Stripe when a webhook arrives, so a missed or failed one leaves silent drift.
 *
 * Reads this stage's non-canceled Stripe subscriptions and matches them to the non-terminal
 * Stripe-sourced rows by subscription id. Rows the listing never showed are retrieved one by one:
 * canceled at Stripe is status drift, deleted at Stripe is an orphan. A live Stripe subscription with
 * no row is the other orphan. Every comparison goes through the projection Sync writes
 * (stripeSubscriptionRowFields), so what is flagged is exactly what Sync would change.
 *
 * Read-only against Stripe (subscriptions.list and subscriptions.retrieve only) and it never repairs:
 * it only upserts findings. A run that hits the time budget resolves nothing it did not cover.
 *
 * Schedule: daily at 06:30 UTC
 */

import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import {
  billingMismatchRepository,
  connectDB,
  organizationRepository,
  type BillingMismatchFinding,
} from '@bike4mind/database';
import { isStripeConfigured, stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { diffSubscription, isStageSubscription, withinGrace } from './subscriptionReconciliation/compareSubscription';

const CLOUDWATCH_NAMESPACE = 'Lumina5/Billing';
const MAX_ALERT_LINES = 20;
// Left in the Lambda for the findings write and the Slack post after the Stripe calls stop.
const BUDGET_MARGIN_MS = 60 * 1000;
const ORPHAN_STATUSES = new Set(['active', 'trialing', 'past_due']);

// Derived rather than imported: the stripe package is a dependency of apps/client, not of workers.
type StripeSubscription = Omit<Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>, 'lastResponse'>;

export interface SubscriptionReconciliationResult {
  checked: number;
  findings: BillingMismatchFinding[];
  newFindings: number;
  resolved: number;
  /** True when the time budget ran out before every subscription was covered. */
  truncated: boolean;
}

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

const isResourceMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'resource_missing';

function formatAlert(stage: string, result: SubscriptionReconciliationResult): string {
  // Owner ids only, never emails: this lands in a shared channel.
  const lines = result.findings.slice(0, MAX_ALERT_LINES).map(f => {
    const what = f.kind === 'drift' ? f.fields.map(x => x.field).join(', ') : f.kind.replace('_', ' ');
    return `- ${f.stripeSubscriptionId} (${f.ownerType ?? 'unknown'} ${f.ownerId ?? 'unknown'}): ${what}`;
  });
  const more = result.findings.length - lines.length;
  return [
    `:warning: *Subscriptions out of step with Stripe* (${stage}): ${result.newFindings} new, ` +
      `${result.findings.length} open from this run.`,
    ...lines,
    ...(more > 0 ? [`...and ${more} more (see the Mismatched view and the SubscriptionReconciliation logs).`] : []),
    ...(result.truncated ? ['Run truncated at the time budget; some subscriptions were not checked.'] : []),
    'Review them in Admin > Subscriptions > Mismatched; Sync from Stripe repairs a row from Stripe.',
  ].join('\n');
}

export async function runSubscriptionReconciliation(
  logger: Logger = new Logger(),
  now: Date = new Date(),
  deadline: number = Number.POSITIVE_INFINITY
): Promise<SubscriptionReconciliationResult> {
  const stage = Resource.App.stage;
  const rows = await subscriptionRepository.findNonTerminalStripeRows();
  const unseen = new Map(rows.map(row => [row.subscriptionId as string, row]));
  const findings: BillingMismatchFinding[] = [];
  const covered = new Set<string>();
  let checked = 0;
  let truncated = false;

  const orgSeatsFor = async (row: (typeof rows)[number]) =>
    row.ownerType === SubscriptionOwnerType.Organization
      ? (await organizationRepository.findById(row.ownerId))?.seats
      : undefined;

  const driftFinding = async (
    row: (typeof rows)[number],
    sub: StripeSubscription
  ): Promise<BillingMismatchFinding | null> => {
    const fields = diffSubscription(row, sub, await orgSeatsFor(row));
    if (fields.length === 0) return null;
    return {
      stripeSubscriptionId: sub.id,
      kind: 'drift',
      subscriptionRowId: String(row.id),
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      fields,
      stripeStatus: sub.status,
    };
  };

  await stripe.subscriptions.list({ limit: 100 }).autoPagingEach(async sub => {
    if (Date.now() > deadline) {
      truncated = true;
      return false;
    }
    if (!isStageSubscription(sub, stage)) return;
    checked++;
    const row = unseen.get(sub.id);
    unseen.delete(sub.id);
    if (withinGrace(row ?? null, sub, now)) return;
    covered.add(sub.id);
    if (row) {
      const finding = await driftFinding(row, sub);
      if (finding) findings.push(finding);
    } else if (ORPHAN_STATUSES.has(sub.status)) {
      findings.push({
        stripeSubscriptionId: sub.id,
        kind: 'orphan_stripe',
        subscriptionRowId: null,
        ownerType: sub.metadata?.ownerType ?? null,
        ownerId: sub.metadata?.organizationId || sub.metadata?.userId || null,
        fields: [],
        stripeStatus: sub.status,
      });
    }
  });

  const completeListing = !truncated;
  if (completeListing) {
    for (const [subscriptionId, row] of unseen) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      checked++;
      if (withinGrace(row, { created: 0 }, now)) continue;
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        covered.add(subscriptionId);
        const finding = await driftFinding(row, sub);
        if (finding) findings.push(finding);
      } catch (error) {
        if (!isResourceMissing(error)) {
          logger.warn('[SubscriptionReconciliation] Could not retrieve subscription; left uncovered', {
            subscriptionId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        covered.add(subscriptionId);
        findings.push({
          stripeSubscriptionId: subscriptionId,
          kind: 'orphan_mongo',
          subscriptionRowId: String(row.id),
          ownerType: row.ownerType,
          ownerId: row.ownerId,
          fields: [],
          stripeStatus: null,
        });
      }
    }
  }

  let newFindings = 0;
  for (const finding of findings) {
    if (await billingMismatchRepository.upsertOpen(finding, now)) newFindings++;
  }
  const resolved = await billingMismatchRepository.resolveMissing({
    coveredIds: [...covered],
    seenIds: findings.map(f => f.stripeSubscriptionId),
    completeListing,
    now,
  });

  const result: SubscriptionReconciliationResult = { checked, findings, newFindings, resolved, truncated };
  for (const finding of findings) {
    logger.warn('[SubscriptionReconciliation] Subscription out of step with Stripe', finding);
  }
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'SubscriptionMismatches',
    findings.length,
    { Stage: stage },
    StandardUnit.Count
  );
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'ReconciliationTruncated',
    truncated ? 1 : 0,
    { Stage: stage },
    StandardUnit.Count
  );
  if (newFindings > 0) await postMessageToSlack(formatAlert(stage, result));

  logger.log(
    `[SubscriptionReconciliation] Checked ${checked}: ${findings.length} mismatched (${newFindings} new), ` +
      `${resolved} resolved${truncated ? ' (truncated)' : ''}`
  );
  return result;
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  if (!isStripeConfigured()) {
    logger.log('[SubscriptionReconciliation] Stripe not configured, skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const deadline = Date.now() + context.getRemainingTimeInMillis() - BUDGET_MARGIN_MS;
  const { checked, findings, newFindings, resolved, truncated } = await runSubscriptionReconciliation(
    logger,
    new Date(),
    deadline
  );
  return {
    statusCode: 200,
    body: JSON.stringify({ checked, mismatched: findings.length, newFindings, resolved, truncated }),
  };
}
