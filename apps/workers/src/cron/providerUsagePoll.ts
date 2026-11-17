/**
 * Provider Usage Poll
 *
 * Reads the previous complete UTC hour from the Anthropic and OpenAI admin usage reports, prices it
 * with our model rates and publishes it to the LLMSpend namespace (ProviderReportedUsd and friends,
 * alarmed in infra/providerSpend.ts, as is UnpricedOutputTokens). Unlike the ledger-derived EstimatedUsd (infra/llmSpend.ts),
 * this counts every call billed to the organization, whichever service made it.
 *
 * Prices come from the static adapter tables plus the ModelPrice snapshot that model discovery
 * writes to S3 (modelPriceSnapshotWriter.ts); without the snapshot the static tables alone price
 * the hour.
 *
 * A provider whose admin key is not configured is skipped and publishes ProviderUsagePollSkipped
 * instead. A provider whose report cannot be read fails the run after the others are published, so
 * the poller-errors alarm sees it.
 *
 * Schedule: hourly at minute 7 UTC
 * Enabled: production + dev
 */

import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { MODEL_PRICE_SNAPSHOT_KEY, ModelPriceSnapshot, type IModelPriceSnapshot } from '@bike4mind/common';
import { randomUUID } from 'crypto';
import { spendReconciliationService } from '@bike4mind/services';
import { Resource } from 'sst';
import { resolveProviderAdminKey } from './providerAdminKey';
import { MODEL_PRICE_SNAPSHOT_BUCKET_ENV } from './modelPriceSnapshotWriter';

type ProviderHourlyUsage = spendReconciliationService.ProviderHourlyUsage;
type UsageReportProvider = spendReconciliationService.UsageReportProvider;

const HOUR_MS = 3_600_000;
const SNAPSHOT_STALE_MS = 24 * HOUR_MS;

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

interface ProviderConfig {
  provider: UsageReportProvider;
  fetch: (key: string, start: Date, end: Date) => Promise<ProviderHourlyUsage[]>;
}

const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'anthropic',
    fetch: (key, start, end) =>
      spendReconciliationService.fetchAnthropicHourlyUsage(key, start.toISOString(), end.toISOString()),
  },
  {
    provider: 'openai',
    fetch: (key, start, end) =>
      spendReconciliationService.fetchOpenAIHourlyUsage(key, start.getTime() / 1000, end.getTime() / 1000),
  },
];

/** The last complete UTC hour before `now`: [floor(now) - 1h, floor(now)). */
export function previousHourWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  return { start: new Date(end.getTime() - HOUR_MS), end };
}

/** Null on any failure: the hour is then priced from the static tables alone, as before the snapshot existed. */
async function loadModelPriceSnapshot(logger: Logger, now: Date): Promise<IModelPriceSnapshot | null> {
  const bucket = process.env[MODEL_PRICE_SNAPSHOT_BUCKET_ENV];
  if (!bucket) {
    logger.warn('[ProviderUsagePoll] model price snapshot bucket not configured, using static prices');
    return null;
  }
  try {
    const object = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: MODEL_PRICE_SNAPSHOT_KEY }));
    const snapshot = ModelPriceSnapshot.parse(JSON.parse((await object.Body?.transformToString()) ?? ''));
    logger.info(
      `[ProviderUsagePoll] model price snapshot generatedAt=${snapshot.generatedAt} rows=${snapshot.rows.length}`
    );
    if (now.getTime() - Date.parse(snapshot.generatedAt) > SNAPSHOT_STALE_MS) {
      logger.warn(`[ProviderUsagePoll] model price snapshot is older than 24h (generatedAt=${snapshot.generatedAt})`);
    }
    return snapshot;
  } catch (err) {
    logger.warn('[ProviderUsagePoll] model price snapshot unavailable, using static prices', err);
    return null;
  }
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  const now = new Date();
  const { start, end } = previousHourWindow(now);
  const window = `${start.toISOString()}..${end.toISOString()}`;

  const metricData: MetricDatum[] = [];
  const failed: string[] = [];
  let published = 0;
  let skipped = 0;
  const snapshot = (await loadModelPriceSnapshot(logger, now)) ?? undefined;

  for (const { provider, fetch } of PROVIDERS) {
    let key: string | undefined;
    try {
      key = await resolveProviderAdminKey(provider);
    } catch (err) {
      failed.push(provider);
      logger.error(`[ProviderUsagePoll] ${provider} ${window} admin key lookup failed`, err);
      continue;
    }
    if (!key || key === 'not-configured') {
      logger.warn(`[ProviderUsagePoll] ${provider}: admin key not configured, skipping`);
      // Read by the per-provider skipped alarm in infra/providerSpend.ts.
      metricData.push({
        MetricName: 'ProviderUsagePollSkipped',
        Value: 1,
        Unit: 'Count',
        Dimensions: [{ Name: 'Provider', Value: provider }],
        Timestamp: now,
      });
      skipped++;
      continue;
    }

    try {
      const rows = await fetch(key, start, end);
      const price = await spendReconciliationService.priceProviderUsage(provider, rows, undefined, snapshot);
      if (price.unpricedModels.length > 0) {
        logger.warn(
          `[ProviderUsagePoll] ${provider}: no price for ${price.unpricedModels.join(', ')} ` +
            `(${price.unpricedOutputTokens} output tokens)`
        );
      }

      // The value covers the previous full hour, but it is stamped at run time: the alarm period is
      // one hour, so a point stamped an hour back would land in a period the alarm already closed.
      const dimensions = [{ Name: 'Provider', Value: provider }];
      metricData.push(
        { MetricName: 'ProviderReportedUsd', Value: price.usd, Unit: 'None', Dimensions: dimensions, Timestamp: now },
        {
          MetricName: 'ProviderReportedOutputTokens',
          Value: price.outputTokens,
          Unit: 'Count',
          Dimensions: dimensions,
          Timestamp: now,
        },
        {
          MetricName: 'UnpricedOutputTokens',
          Value: price.unpricedOutputTokens,
          Unit: 'Count',
          Dimensions: dimensions,
          Timestamp: now,
        }
      );

      published++;

      const models = new Set(rows.map(row => row.model)).size;
      logger.info(
        `[ProviderUsagePoll] ${provider} ${window}: usd=$${price.usd.toFixed(2)} ` +
          `outputTokens=${price.outputTokens} models=${models}`
      );
    } catch (err) {
      failed.push(provider);
      logger.error(`[ProviderUsagePoll] ${provider} ${window} failed`, err);
    }
  }

  if (metricData.length > 0) {
    await new CloudWatchClient({}).send(
      new PutMetricDataCommand({
        Namespace: `${Resource.App.name}/${Resource.App.stage}/LLMSpend`,
        MetricData: metricData,
      })
    );
  }

  if (failed.length > 0) {
    throw new Error(`[ProviderUsagePoll] usage report failed for ${failed.join(', ')}`);
  }

  return { published, skipped };
}
