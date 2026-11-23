/**
 * Provider Usage Poll
 *
 * Reads the previous complete UTC hour from the Anthropic and OpenAI admin usage reports, prices it
 * with our model rates and publishes it to the LLMSpend namespace (ProviderReportedUsd and friends,
 * alarmed in infra/providerSpend.ts, as is UnpricedOutputTokens). Unlike the ledger-derived EstimatedUsd (infra/llmSpend.ts),
 * this counts every call billed to the organization, whichever service made it.
 *
 * Where a provider spend scope is configured for the stage (providerSpendScope.ts), ProviderReportedUsd
 * and the token metrics cover only that scope, the same scope the nightly reconciliation applies, and
 * ProviderReportedOrgUsd keeps the organization-wide figure so spend outside the stage stays visible.
 *
 * Prices come from the static adapter tables plus the ModelPrice snapshot that model discovery
 * writes to S3 (modelPriceSnapshotWriter.ts); without the snapshot the static tables alone price
 * the hour.
 * Every run also publishes ModelPriceSnapshotAgeHours and ModelPriceSnapshotMissing for that snapshot.
 *
 * A provider whose admin key is not configured is skipped and publishes ProviderUsagePollSkipped
 * instead. A provider whose report cannot be read fails the run after the others are published, so
 * the poller-errors alarm sees it. A key read from the secret store also publishes
 * ProviderAdminKeyAgeDays, the age of its current version.
 *
 * Schedule: hourly at minute 7 UTC
 * Enabled: production + dev
 */

import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  modelPriceSnapshotDeadline,
  ModelPriceSnapshotBudgetError,
  withModelPriceSnapshotBudget,
} from './modelPriceSnapshotBudget';
import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import {
  MODEL_PRICE_SNAPSHOT_BUCKET_ENV,
  MODEL_PRICE_SNAPSHOT_KEY,
  ModelPriceSnapshot,
  type IModelPriceSnapshot,
} from '@bike4mind/common';
import { randomUUID } from 'crypto';
import { spendReconciliationService } from '@bike4mind/services';
import { Resource } from 'sst';
import { lookupProviderAdminKey } from './providerAdminKey';
import { describeProviderSpendScope, readProviderSpendScope } from './providerSpendScope';

type ProviderHourlyUsage = spendReconciliationService.ProviderHourlyUsage;
type UsageReportProvider = spendReconciliationService.UsageReportProvider;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SNAPSHOT_STALE_MS = DAY_MS;
// A snapshot dated further ahead than this is treated as implausible, not as clock skew.
const SNAPSHOT_FUTURE_SKEW_MS = HOUR_MS;
// Reserve time for the primary provider reports and metric publication; their own budgets are separate.
const SNAPSHOT_HEADROOM_MS = 30_000;

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

interface ScopedUsage {
  rows: ProviderHourlyUsage[];
  /** Undefined when the stage has no scope, so every row is in scope. */
  scope: object | undefined;
}

interface ProviderConfig {
  provider: UsageReportProvider;
  fetch: (key: string, start: Date, end: Date) => Promise<ScopedUsage>;
}

const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'anthropic',
    fetch: async (key, start, end) => {
      const scope = await readProviderSpendScope('anthropic');
      const rows = await spendReconciliationService.fetchAnthropicHourlyUsage(
        key,
        start.toISOString(),
        end.toISOString(),
        scope
      );
      return { rows, scope };
    },
  },
  {
    provider: 'openai',
    fetch: async (key, start, end) => {
      const scope = await readProviderSpendScope('openai');
      const rows = await spendReconciliationService.fetchOpenAIHourlyUsage(
        key,
        start.getTime() / 1000,
        end.getTime() / 1000,
        scope
      );
      return { rows, scope };
    },
  },
];

/** The last complete UTC hour before `now`: [floor(now) - 1h, floor(now)). */
export function previousHourWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  return { start: new Date(end.getTime() - HOUR_MS), end };
}

/** Undefined on any failure: the hour is then priced from the static tables alone, as before the snapshot existed. */
async function loadModelPriceSnapshot(
  logger: Logger,
  now: Date,
  deadlineMs: number
): Promise<IModelPriceSnapshot | undefined> {
  const bucket = process.env[MODEL_PRICE_SNAPSHOT_BUCKET_ENV];
  if (!bucket) {
    logger.warn('[ProviderUsagePoll] model price snapshot bucket not configured, using static prices');
    return undefined;
  }
  try {
    const snapshot = await withModelPriceSnapshotBudget(deadlineMs, async (signal, assertActive) => {
      const object = await new S3Client({}).send(
        new GetObjectCommand({ Bucket: bucket, Key: MODEL_PRICE_SNAPSHOT_KEY }),
        { abortSignal: signal }
      );
      const body = object.Body;
      let disposed = false;
      const disposeBody = () => {
        if (disposed) return;
        disposed = true;
        // Workers use the Node SDK stream. Also dispose a response delivered after its abort.
        if (body instanceof Readable) body.destroy();
      };
      signal.addEventListener('abort', disposeBody, { once: true });
      try {
        assertActive();
        const text = await body?.transformToString();
        assertActive();
        return ModelPriceSnapshot.parse(JSON.parse(text ?? ''));
      } finally {
        signal.removeEventListener('abort', disposeBody);
        if (signal.aborted) disposeBody();
      }
    });
    logger.info(
      `[ProviderUsagePoll] model price snapshot generatedAt=${snapshot.generatedAt} rows=${snapshot.rows.length}`
    );
    const ageMs = now.getTime() - Date.parse(snapshot.generatedAt);
    if (Number.isNaN(ageMs) || ageMs > SNAPSHOT_STALE_MS || ageMs < -SNAPSHOT_FUTURE_SKEW_MS) {
      logger.warn(
        `[ProviderUsagePoll] model price snapshot timestamp is stale or implausible (generatedAt=${snapshot.generatedAt})`
      );
    }
    return snapshot;
  } catch (err) {
    logger.warn(
      '[ProviderUsagePoll] model price snapshot unavailable, using static prices',
      err instanceof ModelPriceSnapshotBudgetError ? err : new Error('Optional model price snapshot read failed')
    );
    return undefined;
  }
}

/**
 * ModelPriceSnapshotAgeHours is published only for a snapshot with a plausible timestamp; otherwise
 * ModelPriceSnapshotMissing is 1. Global metrics, so no dimensions. Read by the alarms in infra/providerSpend.ts.
 */
export function modelPriceSnapshotMetrics(snapshot: IModelPriceSnapshot | undefined, now: Date): MetricDatum[] {
  const ageMs = snapshot ? now.getTime() - Date.parse(snapshot.generatedAt) : Number.NaN;
  const plausible = !Number.isNaN(ageMs) && ageMs >= -SNAPSHOT_FUTURE_SKEW_MS;
  const metrics: MetricDatum[] = [];
  if (plausible) {
    metrics.push({
      MetricName: 'ModelPriceSnapshotAgeHours',
      Value: Math.max(0, ageMs / HOUR_MS),
      Unit: 'None',
      Timestamp: now,
    });
  }
  metrics.push({ MetricName: 'ModelPriceSnapshotMissing', Value: plausible ? 0 : 1, Unit: 'Count', Timestamp: now });
  return metrics;
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
  const snapshot = await loadModelPriceSnapshot(
    logger,
    now,
    modelPriceSnapshotDeadline(context.getRemainingTimeInMillis?.(), SNAPSHOT_HEADROOM_MS)
  );

  for (const { provider, fetch } of PROVIDERS) {
    let key: string | undefined;
    let keyCreatedAt: Date | undefined;
    try {
      ({ key, createdAt: keyCreatedAt } = await lookupProviderAdminKey(provider));
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

    if (keyCreatedAt) {
      // Read by the per-provider key age alarm in infra/providerSpend.ts. Published before the report
      // is fetched, so a run whose report fails still reports the age.
      metricData.push({
        MetricName: 'ProviderAdminKeyAgeDays',
        Value: Math.max(0, (now.getTime() - keyCreatedAt.getTime()) / DAY_MS),
        Unit: 'None',
        Dimensions: [{ Name: 'Provider', Value: provider }],
        Timestamp: now,
      });
    }

    try {
      const { rows: allRows, scope } = await fetch(key, start, end);
      const rows = allRows.filter(row => row.inScope);
      const price = await spendReconciliationService.priceProviderUsage(provider, rows, undefined, snapshot);
      const orgPrice = scope
        ? await spendReconciliationService.priceProviderUsage(provider, allRows, undefined, snapshot)
        : price;
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
          MetricName: 'ProviderReportedOrgUsd',
          Value: orgPrice.usd,
          Unit: 'None',
          Dimensions: dimensions,
          Timestamp: now,
        },
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
          `orgUsd=$${orgPrice.usd.toFixed(2)} scope=${describeProviderSpendScope(scope)} ` +
          `outputTokens=${price.outputTokens} models=${models}`
      );
    } catch (err) {
      failed.push(provider);
      logger.error(`[ProviderUsagePoll] ${provider} ${window} failed`, err);
    }
  }

  metricData.push(...modelPriceSnapshotMetrics(snapshot, now));
  await new CloudWatchClient({}).send(
    new PutMetricDataCommand({
      Namespace: `${Resource.App.name}/${Resource.App.stage}/LLMSpend`,
      MetricData: metricData,
    })
  );

  if (failed.length > 0) {
    throw new Error(`[ProviderUsagePoll] usage report failed for ${failed.join(', ')}`);
  }

  return { published, skipped };
}
