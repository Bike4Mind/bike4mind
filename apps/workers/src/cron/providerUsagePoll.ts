/**
 * Provider Usage Poll
 *
 * Reads the previous complete UTC hour from the Anthropic and OpenAI admin usage reports, prices it
 * with our model rates and publishes it to the LLMSpend namespace (ProviderReportedUsd and friends,
 * alarmed in infra/providerSpend.ts). Unlike the ledger-derived EstimatedUsd (infra/llmSpend.ts),
 * this counts every call billed to the organization, whichever service made it.
 *
 * A provider whose admin key is not configured is skipped. A provider whose report cannot be read
 * fails the run after the others are published, so the poller-errors alarm sees it.
 *
 * Schedule: hourly at minute 7 UTC
 * Enabled: production + dev
 */

import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { spendReconciliationService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

type ProviderHourlyUsage = spendReconciliationService.ProviderHourlyUsage;
type UsageReportProvider = spendReconciliationService.UsageReportProvider;

const HOUR_MS = 3_600_000;

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

interface ProviderConfig {
  provider: UsageReportProvider;
  getKey: () => string | undefined;
  fetch: (key: string, start: Date, end: Date) => Promise<ProviderHourlyUsage[]>;
}

const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'anthropic',
    getKey: () => Config.ANTHROPIC_ADMIN_API_KEY,
    fetch: (key, start, end) =>
      spendReconciliationService.fetchAnthropicHourlyUsage(key, start.toISOString(), end.toISOString()),
  },
  {
    provider: 'openai',
    getKey: () => Config.OPENAI_ADMIN_API_KEY,
    fetch: (key, start, end) =>
      spendReconciliationService.fetchOpenAIHourlyUsage(key, start.getTime() / 1000, end.getTime() / 1000),
  },
];

/** The last complete UTC hour before `now`: [floor(now) - 1h, floor(now)). */
export function previousHourWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  return { start: new Date(end.getTime() - HOUR_MS), end };
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  const now = new Date();
  const { start, end } = previousHourWindow(now);
  const window = `${start.toISOString()}..${end.toISOString()}`;

  const metricData: MetricDatum[] = [];
  const failed: string[] = [];
  let skipped = 0;

  for (const { provider, getKey, fetch } of PROVIDERS) {
    const key = getKey();
    if (!key || key === 'not-configured') {
      logger.warn(`[ProviderUsagePoll] ${provider}: admin key not configured, skipping`);
      skipped++;
      continue;
    }

    try {
      const rows = await fetch(key, start, end);
      const price = await spendReconciliationService.priceProviderUsage(provider, rows);
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

  return { published: metricData.length / 3, skipped };
}
