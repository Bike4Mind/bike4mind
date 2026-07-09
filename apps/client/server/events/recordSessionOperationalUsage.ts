import { getTextModelCost, ModelInfo } from '@bike4mind/common';
import { recordOperationalUsage } from '@bike4mind/services';
import {
  adminSettingsRepository,
  creditTransactionRepository,
  organizationRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

export interface RecordSessionOperationalUsageArgs {
  /** Owner of the session; attribution rolls up to their org when they have one. */
  userId?: string;
  sessionId: string;
  modelId: string;
  modelInfo: ModelInfo;
  /** Token usage reported by the LLM callback; some backends leave it undefined. */
  completionInfo?: CompletionInfo;
  /** Set just before the llm.complete call so latency reflects the model call, not setup. */
  startTime: number;
  logger: Logger;
}

/**
 * Record a UsageEvent for an operational-model call made on a session's behalf (auto-naming,
 * summarization, tagging, context summarization). Resolves the owner (user + org) from the
 * session's user and hands off to the shared recorder, which decides billed-vs-recorded-only.
 *
 * Best-effort: any failure is swallowed with a warning so it can never break the non-critical
 * background handler it measures. Skips silently when the owner or token usage is unknown -
 * there is nothing meaningful to attribute or cost.
 */
export async function recordSessionOperationalUsage(args: RecordSessionOperationalUsageArgs): Promise<void> {
  const { userId, completionInfo, modelInfo, modelId, sessionId, logger } = args;

  if (!userId) {
    logger.debug('[recordSessionOperationalUsage] no userId on session; skipping usage record');
    return;
  }

  const inputTokens = completionInfo?.inputTokens ?? 0;
  const outputTokens = completionInfo?.outputTokens ?? 0;
  const cacheReadTokens = completionInfo?.cacheReadInputTokens ?? 0;
  const cacheWriteTokens = completionInfo?.cacheCreationInputTokens ?? 0;

  if (inputTokens === 0 && outputTokens === 0) {
    logger.debug('[recordSessionOperationalUsage] backend reported no token usage; skipping usage record');
    return;
  }

  try {
    const user = await userRepository.findById(userId);
    if (!user) {
      logger.debug(`[recordSessionOperationalUsage] user ${userId} not found; skipping usage record`);
      return;
    }
    const organization = user.organizationId ? await organizationRepository.findById(user.organizationId) : null;
    const costUsd = getTextModelCost(modelInfo, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

    await recordOperationalUsage(
      {
        requestId: sessionId,
        user,
        organization,
        sessionId,
        feature: 'operations',
        provider: modelInfo.backend,
        model: modelId,
        inputTokens,
        outputTokens,
        cachedInputTokens: cacheReadTokens,
        cacheWriteTokens,
        costUsd,
        latencyMs: Date.now() - args.startTime,
        source: 'system',
      },
      {
        db: {
          usageEvents: usageEventRepository,
          adminSettings: adminSettingsRepository,
          creditTransactions: creditTransactionRepository,
          users: userRepository,
          organizations: organizationRepository,
        },
        logger,
      }
    );
  } catch (err) {
    logger.warn('[recordSessionOperationalUsage] failed to record operational usage', err);
  }
}
