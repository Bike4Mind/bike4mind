/**
 * Writes the admin Revenue trend's RevenueSnapshot for the UTC day that just ended; upsert, so reruns replace it.
 * Schedule: daily at 00:20 UTC (infra/cron.ts revenueSnapshot); a missed day stays a gap, only current state exists.
 * Self-host: none yet. Math: apps/client/server/admin/revenue/revenueSnapshot.ts.
 */

import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { Logger } from '@bike4mind/observability';
import { connectDB, revenueSnapshotRepository } from '@bike4mind/database';
import { isStripeConfigured } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { Config } from '@bike4mind/server-utils/utils/config';
import { computeRevenueSnapshot } from '@server/admin/revenue/revenueSnapshot';
import { Resource } from 'sst';

const DAY_MS = 86_400_000;

export const snapshotDayFor = (now: Date): string => new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);

export async function runRevenueSnapshot(logger: Logger = new Logger(), now: Date = new Date()) {
  const day = snapshotDayFor(now);
  const snapshot = await computeRevenueSnapshot(day, now);
  await revenueSnapshotRepository.upsertSnapshot(snapshot);
  logger.log(
    `[RevenueSnapshot] ${day}: MRR ${snapshot.mrr.amount} ${snapshot.currency}, ${snapshot.payingCount} paying, ` +
      `new ${snapshot.newMrr.amount}, churned ${snapshot.churnedMrr.amount}`
  );
  return snapshot;
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId ?? randomUUID(),
    functionName: context.functionName,
    stage: Resource.App.stage,
  });
  if (!isStripeConfigured()) {
    logger.log('[RevenueSnapshot] Stripe not configured, skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const snapshot = await runRevenueSnapshot(logger);
  return { statusCode: 200, body: JSON.stringify({ snapshotDate: snapshot.snapshotDate }) };
}
