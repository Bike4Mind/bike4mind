import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import {
  UserApiKeyEvents,
  AiEvents,
  getTextModelCost,
  getTurnsCost,
  type TurnUsage,
  ChatModels,
  IApiKeyRepository,
  IAdminSettingsRepository,
  type CompletionSource,
  usdToCreditsExpected,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { resolveOpenAiBareModelAlias } from '@bike4mind/services/cliCompletions';
import { z } from 'zod';
import type { CompletionRequestSchema } from '@bike4mind/common';

interface BaseAnalyticsParams {
  userId: string;
  body: z.infer<typeof CompletionRequestSchema>;
  apiKeyInfo?: { keyId: string; keyName: string };
  /** Where this completion originated (cli, api, etc.) - recorded on the event for source breakdown */
  source: CompletionSource;
  startTime: number;
  endpoint: string;
  method: string;
  /** Correlation ID for this request, when available. */
  requestId?: string;
  logger: Logger | { error: (msg: string, error: unknown) => void };
  /** Database repositories for fetching model pricing info; required for accurate credits calculation. */
  db: {
    apiKeys: IApiKeyRepository;
    adminSettings: IAdminSettingsRepository;
  };
}

interface SuccessAnalyticsParams extends BaseAnalyticsParams {
  type: 'success';
  finalInputTokens: number;
  finalOutputTokens: number;
  /** Cache tokens from the completion frames (disjoint from finalInputTokens), for the totals fallback. */
  finalCacheReadTokens?: number;
  finalCacheWriteTokens?: number;
  /** Per-request usage from the completion frames, when the adapter reports it (see getTurnsCost). */
  finalTurnUsage?: TurnUsage[];
  /** Credits executeCompletion settled for this completion (its final chunk's creditsUsed); preferred over re-pricing. */
  finalCreditsUsed?: number;
  hasToolCalls: boolean;
  error?: never;
}

interface FailureAnalyticsParams extends BaseAnalyticsParams {
  type: 'failure';
  error: unknown;
  finalInputTokens?: never;
  finalOutputTokens?: never;
  finalCacheReadTokens?: never;
  finalCacheWriteTokens?: never;
  finalTurnUsage?: never;
  finalCreditsUsed?: never;
  hasToolCalls?: never;
  modelInfo?: never;
}

type LogCompletionAnalyticsParams = SuccessAnalyticsParams | FailureAnalyticsParams;

/**
 * Shared utility for logging completion analytics events
 * Used by both Next.js API route and Lambda handler
 *
 * Logs two types of events:
 * 1. UserApiKeyEvents.USED - When authenticated via API key (forensics, usage tracking)
 * 2. AiEvents.COMPLETION_API_COMPLETED/FAILED - Completion performance tracking
 */
export async function logCompletionAnalytics(params: LogCompletionAnalyticsParams): Promise<void> {
  const { type, userId, body, apiKeyInfo, source, startTime, endpoint, method, requestId, logger } = params;

  const durationMs = Date.now() - startTime;
  const authMethod = apiKeyInfo ? ('api_key' as const) : ('jwt' as const);

  if (type === 'success') {
    const {
      finalInputTokens,
      finalOutputTokens,
      finalCacheReadTokens,
      finalCacheWriteTokens,
      finalTurnUsage,
      finalCreditsUsed,
      hasToolCalls,
      db,
    } = params;

    let creditsUsed = 0;
    try {
      // Get effective API keys (user keys or fallback to admin demo keys)
      const apiKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, { db, getSettingsByNames });

      // Same table executeCompletion builds, so this hits its model-list cache entry instead of evicting it.
      const models = await getAvailableModels(buildApiKeyTable(apiKeys));
      // Same resolution executeCompletion applies to the request before billing it, so a
      // bare OpenAI alias (e.g. "gpt-4.1") that the completion succeeded on doesn't come
      // back here as "model not found" and log a spurious zero-credit event.
      const resolvedModelId = resolveOpenAiBareModelAlias(body.model);
      const modelInfo = models.find(m => m.id === (resolvedModelId as ChatModels));

      if (finalCreditsUsed !== undefined) {
        // The settled figure, even when the adapter reported no output tokens.
        creditsUsed = finalCreditsUsed;
      } else if (modelInfo && finalInputTokens > 0 && finalOutputTokens > 0) {
        const costInUsd = finalTurnUsage?.length
          ? getTurnsCost(modelInfo, finalTurnUsage)
          : getTextModelCost(
              modelInfo,
              finalInputTokens,
              finalOutputTokens,
              finalCacheReadTokens ?? 0,
              finalCacheWriteTokens ?? 0,
              finalInputTokens + (finalCacheReadTokens ?? 0) + (finalCacheWriteTokens ?? 0)
            );
        // Settlement is stochastic, so the fallback is its expectation, not a round-up.
        creditsUsed = usdToCreditsExpected(costInUsd);
      } else if (!modelInfo) {
        // Model not found - log warning but don't fail analytics
        logger.error('[COMPLETION_ANALYTICS] Model not found for credits calculation:', { model: body.model });
      }
    } catch (error) {
      // Don't fail analytics if credits calculation fails
      logger.error('[COMPLETION_ANALYTICS] Failed to calculate credits:', error);
    }

    // NOTE: metadata.modelName (not metadata.model) - the report's `topModels`
    // aggregation keys on `metadata.modelName`.
    await logEvent({
      type: AiEvents.COMPLETION_API_COMPLETED,
      userId,
      metadata: {
        modelName: body.model,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
        durationMs,
        stream: body.options?.stream ?? true,
        apiKeyId: apiKeyInfo?.keyId,
        authMethod,
        creditsUsed,
        hasToolCalls,
        requestId,
        source,
      },
    }).catch(error => {
      logger.error('[COMPLETION_ANALYTICS] Failed to log completion analytics event:', error);
    });

    if (apiKeyInfo) {
      await logEvent({
        type: UserApiKeyEvents.USED,
        userId,
        metadata: {
          keyId: apiKeyInfo.keyId,
          keyPrefix: apiKeyInfo.keyId.substring(0, 16), // Standardized to 16 chars for consistency
          endpoint,
          method,
          responseTime: durationMs,
          statusCode: 200,
          model: body.model,
          inputTokens: finalInputTokens,
          outputTokens: finalOutputTokens,
          stream: body.options?.stream ?? true,
          requestId,
        },
      }).catch(error => {
        logger.error('[COMPLETION_ANALYTICS] Failed to log API key usage event:', error);
      });
    }
  } else {
    const { error } = params;

    await logEvent({
      type: AiEvents.COMPLETION_API_FAILED,
      userId,
      metadata: {
        modelName: body?.model || 'unknown',
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
        apiKeyId: apiKeyInfo?.keyId,
        authMethod,
        durationMs,
        requestId,
        source,
      },
    }).catch(logError => {
      logger.error('[COMPLETION_ANALYTICS] Failed to log failure analytics event:', logError);
    });
  }
}
