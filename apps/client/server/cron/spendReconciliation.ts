/**
 * Nightly Spend Reconciliation
 *
 * Fetches authoritative billing from each provider's admin API, compares
 * against our internal COGS estimate (UsageEvent.monthlyCogsByProvider),
 * and stores a SpendReconciliation snapshot per (month, provider).
 *
 * Reconciles the previous month (closed) and the current month (accruing).
 * Providers whose admin key is not configured are silently skipped.
 *
 * Schedule: daily at 6am UTC
 * Enabled: production + dev
 */

import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { connectDB, spendReconciliationRepository, usageEventRepository } from '@bike4mind/database';
import { ISpendReconciliationInput } from '@bike4mind/common';
import { spendReconciliationService } from '@bike4mind/services';
import { Config } from '@server/utils/config';
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

function getReconcileMonths(): string[] {
  const now = new Date();
  const current = now.toISOString().slice(0, 7);
  // Previous month.
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previous = prev.toISOString().slice(0, 7);
  return [previous, current];
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  logger.log('[SpendReconciliation] Connected to database');

  const months = getReconcileMonths();
  // getReconcileMonths() only ever uses the current and previous month.
  const internalCogs = await usageEventRepository.monthlyCogsByProvider(2);

  let reconciled = 0;
  let skipped = 0;
  let failed = 0;

  for (const providerConfig of PROVIDERS) {
    const key = providerConfig.getKey();
    if (!key || key === 'not-configured') {
      logger.log(`[SpendReconciliation] ${providerConfig.provider}: admin key not configured, skipping`);
      skipped++;
      continue;
    }

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
      } catch (err) {
        // A transient provider error must not be stored as a $0 snapshot;
        // count it and move on so the previous good snapshot stays current.
        failed++;
        logger.error(`[SpendReconciliation] ${providerConfig.provider} ${month} failed`, err);
      }
    }
  }

  logger.log(`[SpendReconciliation] Done: ${reconciled} reconciled, ${skipped} skipped, ${failed} failed`);

  return {
    statusCode: 200,
    body: JSON.stringify({ reconciled, skipped, failed }),
  };
}
