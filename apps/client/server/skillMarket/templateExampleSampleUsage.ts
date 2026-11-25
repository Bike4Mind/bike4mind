import { randomUUID } from 'crypto';
import {
  PLATFORM_USAGE_OWNER_ID,
  PLATFORM_USAGE_OWNER_TYPE,
  type IUsageEventRepository,
  type ModelInfo,
} from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import {
  hasReportedUsage,
  latchUsage,
  priceCompletionUsage,
  type CompletionUsage,
} from '@bike4mind/services/billing/completionMeter';
import { platformPaidUsageEvent } from '@bike4mind/services/llm';

export type SampleCompletion = {
  llm: Pick<ICompletionBackend, 'complete'>;
  modelInfo: ModelInfo;
  /** Same ledger write as the example run's turn (exampleRunWiring.usageEvents), re-owned to the platform. */
  ledger: { usageEvents: Pick<IUsageEventRepository, 'record'> };
  listingId: string;
  timeoutMs: number;
  logger: Logger;
};

/**
 * Writes a template example's sample file on the platform's operations model and records the call's
 * usage as platform-paid. A call that outlives the timeout is still recorded once the provider ends it.
 */
export async function completeSample(opts: SampleCompletion, system: string, user: string): Promise<string> {
  const { llm, modelInfo, ledger, listingId, timeoutMs, logger } = opts;
  const usage: CompletionUsage = {};
  const startedAt = Date.now();
  let timedOut = false;
  let raw = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = llm.complete(
    modelInfo.id,
    [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
    { maxTokens: 1200, stream: false },
    async (parts, info) => {
      latchUsage(usage, info);
      raw += parts.filter(Boolean).join('');
    }
  );
  void call
    .then(
      () => 'ok' as const,
      () => 'error' as const
    )
    .then(async outcome => {
      if (!hasReportedUsage(usage)) return;
      const { costUsd, priceStamp, ...tokens } = priceCompletionUsage(modelInfo, usage);
      await ledger.usageEvents
        .record(
          platformPaidUsageEvent(
            {
              requestId: randomUUID(),
              userId: PLATFORM_USAGE_OWNER_ID,
              ownerId: PLATFORM_USAGE_OWNER_ID,
              ownerType: PLATFORM_USAGE_OWNER_TYPE,
              feature: 'operations',
              provider: modelInfo.backend,
              model: modelInfo.id,
              ...tokens,
              settledBasis: 'provider',
              providerInputTokens: usage.inputTokens,
              providerOutputTokens: usage.outputTokens,
              costUsd,
              creditsCharged: 0,
              ...priceStamp,
              status: timedOut ? 'timeout' : outcome,
              latencyMs: Date.now() - startedAt,
              source: 'system',
            },
            listingId
          )
        )
        .catch(error =>
          logger.warn('[template-example] could not record the sample file usage', {
            listingId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
    });
  await Promise.race([
    call,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('The sample file timed out'));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return raw;
}
