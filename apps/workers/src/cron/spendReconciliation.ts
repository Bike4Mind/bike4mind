/**
 * Nightly Spend Reconciliation
 *
 * Fetches authoritative billing from each provider's admin API, compares
 * against our internal COGS estimate (UsageEvent.monthlyCogsByProvider),
 * and stores a SpendReconciliation snapshot per (month, provider).
 *
 * Reconciles the previous month (closed) and the current month (accruing).
 * Providers whose admin key is not configured are skipped.
 *
 * The hosted handler publishes two metrics alarmed in infra/providerSpend.ts:
 * SpendReconciliationDrift (closed-month rows above SPEND_RECONCILIATION_DRIFT_ALERT_PCT) and
 * SpendReconciliationNothingReconciled (a run where every provider-month was skipped or failed).
 *
 * Schedule: daily at 6am UTC
 * Enabled: production + dev
 */

import { Context } from 'aws-lambda';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { connectDB, spendReconciliationRepository, usageEventRepository } from '@bike4mind/database';
import { ISpendReconciliationInput, SPEND_RECONCILIATION_DRIFT_ALERT_PCT } from '@bike4mind/common';
import { spendReconciliationService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

interface ProviderConfig {
  provider: string;
  source: ISpendReconciliationInput['source'];
  fetch: (key: string, month: string) => Promise<{ providerUsd: number; breakdown: Record<string, number> } | null>;
  getKey: () => string | undefined;
}

const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'anthropic',
    source: 'anthropic_admin_api',
    fetch: spendReconciliationService.fetchAnthropicSpend,
    getKey: () => Config.ANTHROPIC_ADMIN_API_KEY,
  },
  {
    provider: 'openai',
    source: 'openai_usage_api',
    fetch: spendReconciliationService.fetchOpenAISpend,
    getKey: () => Config.OPENAI_ADMIN_API_KEY,
  },
];

function getReconcileMonths(now: Date): string[] {
  const current = now.toISOString().slice(0, 7);
  // Previous month.
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previous = prev.toISOString().slice(0, 7);
  return [previous, current];
}

export interface SpendReconciliationResult {
  reconciled: number;
  skipped: number;
  failed: number;
  /** Closed-month rows whose deltaPct exceeds SPEND_RECONCILIATION_DRIFT_ALERT_PCT. */
  drifted: number;
}

/**
 * Shared by the hosted handler and the self-host worker. The caller owns the DB connection
 * and the stage (it only appears in the caller's logger metadata).
 */
export async function runSpendReconciliation({
  logger,
  now = new Date(),
}: {
  logger: Logger;
  now?: Date;
}): Promise<SpendReconciliationResult> {
  let reconciled = 0;
  let skipped = 0;
  let failed = 0;
  let drifted = 0;

  const configured: { providerConfig: ProviderConfig; key: string }[] = [];
  for (const providerConfig of PROVIDERS) {
    const key = providerConfig.getKey();
    if (!key || key === 'not-configured') {
      logger.log(`[SpendReconciliation] ${providerConfig.provider}: admin key not configured, skipping`);
      skipped++;
      continue;
    }
    configured.push({ providerConfig, key });
  }

  if (configured.length === 0) {
    logger.log(`[SpendReconciliation] Done: no provider admin key configured, ${skipped} skipped`);
    return { reconciled, skipped, failed, drifted };
  }

  const months = getReconcileMonths(now);
  // The accruing month is left out of the drift count: a provider report that lags by a day
  // reads as a large percentage early in the month. The closed month is re-checked every night.
  const [closedMonth] = months;
  // getReconcileMonths() only ever uses the current and previous month.
  const internalCogs = await usageEventRepository.monthlyCogsByProvider(2);

  for (const { providerConfig, key } of configured) {
    for (const month of months) {
      try {
        const result = await providerConfig.fetch(key, month);
        if (!result) {
          skipped++;
          continue;
        }

        const internalRow = internalCogs.find(r => r.month === month && r.provider === providerConfig.provider);
        const internalUsd = internalRow?.cogsUsd ?? 0;
        const deltaUsd = result.providerUsd - internalUsd;
        const denominator = Math.max(result.providerUsd, internalUsd);
        const deltaPct = denominator > 0 ? (Math.abs(deltaUsd) / denominator) * 100 : 0;

        await spendReconciliationRepository.append({
          month,
          provider: providerConfig.provider,
          providerUsd: result.providerUsd,
          internalUsd,
          deltaUsd,
          deltaPct,
          source: providerConfig.source,
          providerBreakdown: Object.keys(result.breakdown).length > 0 ? result.breakdown : undefined,
        });

        reconciled++;
        logger.log(
          `[SpendReconciliation] ${providerConfig.provider} ${month}: ` +
            `provider=$${result.providerUsd.toFixed(2)} internal=$${internalUsd.toFixed(2)} ` +
            `delta=${deltaUsd >= 0 ? '+' : ''}$${deltaUsd.toFixed(2)} (${deltaPct.toFixed(1)}%)`
        );
        if (month === closedMonth && deltaPct > SPEND_RECONCILIATION_DRIFT_ALERT_PCT) {
          drifted++;
          logger.warn(
            `[SpendReconciliation] ${providerConfig.provider} ${month}: drift ${deltaPct.toFixed(1)}% ` +
              `exceeds ${SPEND_RECONCILIATION_DRIFT_ALERT_PCT}%`
          );
        }
      } catch (err) {
        // A transient provider error must not be stored as a $0 snapshot;
        // count it and move on so the previous good snapshot stays current.
        failed++;
        logger.error(`[SpendReconciliation] ${providerConfig.provider} ${month} failed`, err);
      }
    }
  }

  logger.log(
    `[SpendReconciliation] Done: ${reconciled} reconciled, ${skipped} skipped, ${failed} failed, ${drifted} drifted`
  );
  return { reconciled, skipped, failed, drifted };
}

/** Both data points go out on every run, so a healthy night reads as 0 rather than missing. */
async function publishReconciliationMetrics({ reconciled, drifted }: SpendReconciliationResult): Promise<void> {
  const timestamp = new Date();
  await new CloudWatchClient({}).send(
    new PutMetricDataCommand({
      // Must match LLM_SPEND_NAMESPACE in infra/providerSpend.ts.
      Namespace: `${Resource.App.name}/${Resource.App.stage}/LLMSpend`,
      MetricData: [
        { MetricName: 'SpendReconciliationDrift', Value: drifted, Unit: 'Count', Timestamp: timestamp },
        {
          MetricName: 'SpendReconciliationNothingReconciled',
          Value: reconciled === 0 ? 1 : 0,
          Unit: 'Count',
          Timestamp: timestamp,
        },
      ],
    })
  );
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  logger.log('[SpendReconciliation] Connected to database');

  const result = await runSpendReconciliation({ logger });
  await publishReconciliationMetrics(result);
  return { statusCode: 200, body: JSON.stringify(result) };
}
