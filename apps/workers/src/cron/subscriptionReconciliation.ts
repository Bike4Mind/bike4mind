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
 * no row is the other orphan. Open findings whose row has since turned terminal are re-checked so they
 * resolve. The comparison covers status, price, quantity, period end, the cancel flag, amount and the
 * organization's seats, all read through the projection Sync writes (stripeSubscriptionRowFields); Sync
 * applies that whole projection, which includes fields the comparison does not look at.
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
import {
  SubscriptionOwnerType,
  SubscriptionSource,
  TERMINAL_SUBSCRIPTION_STATUSES,
  resolveSubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { diffSubscription, isStageSubscription, withinGrace } from './subscriptionReconciliation/compareSubscription';

const CLOUDWATCH_NAMESPACE = 'Lumina5/Billing';
const MAX_ALERT_LINES = 20;
// Left in the Lambda for the findings write and the Slack post after the Stripe calls stop.
const BUDGET_MARGIN_MS = 60 * 1000;
const TERMINAL_STATUSES = new Set<string>(TERMINAL_SUBSCRIPTION_STATUSES);
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

  const customerIdOf = (sub: StripeSubscription) => (typeof sub.customer === 'string' ? sub.customer : sub.customer.id);
  // The row as read at the start; the findings are re-checked against the live row before they are written.
  const snapshotUpdatedAt = new Map<string, number>();

  // Same lookup Sync's seat write uses (the Stripe customer id), so a flagged seat count is one Sync can change.
  const driftFinding = (
    row: (typeof rows)[number],
    sub: StripeSubscription,
    orgSeats?: number
  ): BillingMismatchFinding | null => {
    const fields = diffSubscription(row, sub, orgSeats);
    if (fields.length === 0) return null;
    snapshotUpdatedAt.set(sub.id, row.updatedAt?.getTime() ?? 0);
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

  // Matched pairs are compared after the listing, so the organizations' seats come in one query
  // instead of one awaited lookup per subscription inside the paging loop.
  const matched: { row: (typeof rows)[number]; sub: StripeSubscription }[] = [];
  const unmatched: StripeSubscription[] = [];
  await stripe.subscriptions.list({ limit: 100 }).autoPagingEach(async sub => {
    if (Date.now() > deadline) {
      truncated = true;
      return false;
    }
    if (!isStageSubscription(sub, stage)) return;
    checked++;
    const row = unseen.get(sub.id);
    unseen.delete(sub.id);
    if (!row) {
      unmatched.push(sub);
      return;
    }
    if (withinGrace(row, sub, now)) return;
    covered.add(sub.id);
    matched.push({ row, sub });
  });

  // A listed subscription with no non-terminal row may still have a terminal one (a wrongly canceled row
  // is drift, not an orphan), so look the rows up in any status before calling it an orphan.
  const unmatchedRows = new Map(
    (await subscriptionRepository.findBySubscriptionIds(unmatched.map(sub => sub.id))).map(r => [
      r.subscriptionId as string,
      r,
    ])
  );
  const orphans: BillingMismatchFinding[] = [];
  for (const sub of unmatched) {
    const row = unmatchedRows.get(sub.id);
    if (withinGrace(row ?? null, sub, now)) continue;
    covered.add(sub.id);
    if (row) {
      // Same rules as the stale phase below: only Stripe-sourced rows are compared, and a row that is
      // finished while Stripe's subscription is too (canceled row, incomplete_expired sub) agrees.
      if (resolveSubscriptionSource(row) !== SubscriptionSource.Stripe) continue;
      if (TERMINAL_STATUSES.has(row.status) && TERMINAL_STATUSES.has(sub.status)) continue;
      matched.push({ row, sub });
    } else if (ORPHAN_STATUSES.has(sub.status)) {
      orphans.push({
        stripeSubscriptionId: sub.id,
        kind: 'orphan_stripe',
        subscriptionRowId: null,
        ownerType: sub.metadata?.ownerType ?? null,
        ownerId: sub.metadata?.organizationId || sub.metadata?.userId || null,
        fields: [],
        stripeStatus: sub.status,
      });
    }
  }
  findings.push(...orphans);

  const orgSeats = await organizationRepository.findSeatsByStripeCustomerIds([
    ...new Set(
      matched.filter(m => m.row.ownerType === SubscriptionOwnerType.Organization).map(m => customerIdOf(m.sub))
    ),
  ]);
  for (const { row, sub } of matched) {
    const seats = row.ownerType === SubscriptionOwnerType.Organization ? orgSeats.get(customerIdOf(sub)) : undefined;
    const finding = driftFinding(row, sub, seats);
    if (finding) findings.push(finding);
  }

  const orgSeatsFor = async (row: (typeof rows)[number], sub: StripeSubscription) =>
    row.ownerType === SubscriptionOwnerType.Organization
      ? (await organizationRepository.findSeatsByStripeCustomerIds([customerIdOf(sub)])).get(customerIdOf(sub))
      : undefined;

  const retrieveOrMissing = async (subscriptionId: string): Promise<StripeSubscription | 'missing' | 'error'> => {
    try {
      return await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      if (isResourceMissing(error)) return 'missing';
      logger.warn('[SubscriptionReconciliation] Could not retrieve subscription; left uncovered', {
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'error';
    }
  };

  const completeListing = !truncated;
  if (completeListing) {
    for (const [subscriptionId, row] of unseen) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      checked++;
      if (withinGrace(row, { created: 0 }, now)) continue;
      const sub = await retrieveOrMissing(subscriptionId);
      if (sub === 'error') continue;
      if (sub !== 'missing' && withinGrace(row, sub, now)) continue;
      covered.add(subscriptionId);
      if (sub === 'missing') {
        findings.push({
          stripeSubscriptionId: subscriptionId,
          kind: 'orphan_mongo',
          subscriptionRowId: String(row.id),
          ownerType: row.ownerType,
          ownerId: row.ownerId,
          fields: [],
          stripeStatus: null,
        });
        continue;
      }
      const finding = driftFinding(row, sub, await orgSeatsFor(row, sub));
      if (finding) findings.push(finding);
    }

    // An open finding whose subscription no phase above visited: its row turned terminal since, so it is
    // never listed or retrieved above. Re-check it so it resolves once the two agree, instead of staying open for good.
    const visited = [...covered, ...rows.map(r => r.subscriptionId as string)];
    const staleIds = await billingMismatchRepository.listOpenRowFindingIds(visited);
    const staleRows = new Map(
      (await subscriptionRepository.findBySubscriptionIds(staleIds)).map(r => [r.subscriptionId as string, r])
    );
    for (const subscriptionId of staleIds) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const row = staleRows.get(subscriptionId);
      if (!row || resolveSubscriptionSource(row) !== SubscriptionSource.Stripe) {
        covered.add(subscriptionId);
        continue;
      }
      checked++;
      if (withinGrace(row, { created: 0 }, now)) continue;
      const sub = await retrieveOrMissing(subscriptionId);
      if (sub === 'error') continue;
      if (sub !== 'missing' && withinGrace(row, sub, now)) continue;
      covered.add(subscriptionId);
      // Gone from Stripe, or finished there too: both sides agree the subscription is over.
      if (sub === 'missing' || TERMINAL_STATUSES.has(sub.status)) continue;
      const finding = driftFinding(row, sub, await orgSeatsFor(row, sub));
      if (finding) findings.push(finding);
    }
  }

  // The listing and retrievals above take minutes. A drift finding whose row was written meanwhile (a webhook,
  // or a Sync) was compared against a stale snapshot, so it is dropped and left for the next run.
  const driftIds = findings.filter(f => f.kind === 'drift').map(f => f.stripeSubscriptionId);
  const live = new Map((await subscriptionRepository.findBySubscriptionIds(driftIds)).map(r => [r.subscriptionId, r]));
  for (let i = findings.length - 1; i >= 0; i--) {
    const { stripeSubscriptionId: id, kind } = findings[i];
    if (kind === 'drift' && (live.get(id)?.updatedAt?.getTime() ?? 0) !== snapshotUpdatedAt.get(id)) {
      findings.splice(i, 1);
      covered.delete(id);
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
