import { IMessage } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { cacheRepository } from '@bike4mind/database';
import { cacheService, meterCompletionBackend, type CompletionMeter } from '@bike4mind/services';
import { refineText } from '@bike4mind/services/llm/refineText';
import {
  OperationsModelService,
  OperationsModelUnavailableError,
} from '@bike4mind/server-utils/services/operationsModelService';
import { CacheKeys } from '@server/utils/cacheKeys';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { createRequestCompletionMeter, type MeteredRequest } from '@server/billing/meterPlatformCompletion';

// Identical (text, context) refinements are common (users re-clicking refine),
// and every miss is a paid operations-model call - cache briefly.
const REFINE_TEXT_CACHE_MS = 5 * 60 * 1000;
// Cap output so one refine can't run away; refined text is short by nature.
const REFINE_TEXT_MAX_TOKENS = 800;

/** Thrown when no operations LLM can be initialised, so callers can map it to their own status. */
export class RefineProviderUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Failed to initialize LLM', { cause });
    this.name = 'RefineProviderUnavailableError';
  }
}

/**
 * Thrown when the model call fails or returns nothing, so callers can map it to a provider-failure
 * status. Carries the original error as `cause` for the log. Cache/DB faults are deliberately NOT
 * wrapped: they are an internal error, not the provider's.
 */
export class RefineFailedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'RefineFailedError';
  }
}

/**
 * Cached operations-model refinement shared by POST /api/ai/refineText and POST /api/v1/text-refinements.
 * A cache miss is credit-metered against the caller (createRequestCompletionMeter); a cache hit makes no
 * provider call and is free. Throws RefineProviderUnavailableError when the deployment has no
 * operations text model, and RefineFailedError when the model call fails or its output is empty (an
 * empty refinement must not be cached). Anything else - a billing refusal (422 insufficient_credits),
 * cache/DB faults, a resolver failure - propagates as itself. A moderated user is refused before the
 * cache, so a cached answer is never served to them either.
 */
export const refineTextRequest = async (
  { text, context }: { text: string; context?: string },
  // cacheService wants the concrete Logger, not MeteredRequest's ILogger; both callers pass one.
  req: MeteredRequest & { logger: Logger }
): Promise<string> => {
  assertAiAccessAllowed(req.user);
  return cacheService.getCachedData(
    CacheKeys.refineText(text, context),
    async () => {
      let operationsModel;
      try {
        operationsModel = await OperationsModelService.getOperationsModel();
      } catch (error) {
        // getOperationsModel never returns a null llm - it throws when it cannot resolve
        // one, which is the same deployment state the public route calls provider_not_configured.
        if (error instanceof OperationsModelUnavailableError) {
          throw new RefineProviderUnavailableError(error);
        }
        throw error;
      }
      const { modelId, modelInfo } = operationsModel;
      // The meter throws its refusal from inside llm.complete; remember it so the catch below can
      // tell a billing refusal (the caller's 422) from a provider failure (RefineFailedError).
      let billingRefusal: unknown;
      const requestMeter = createRequestCompletionMeter(req, 'text refinement', { systemModel: true });
      const meter: CompletionMeter = async (...args) => {
        try {
          return await requestMeter(...args);
        } catch (error) {
          billingRefusal = error;
          throw error;
        }
      };
      const llm = meterCompletionBackend(operationsModel.llm, meter, modelInfo);

      let refined: string | undefined;
      try {
        refined = await refineText(
          { text, context },
          {
            llm: {
              complete: async (messages, callback) => {
                await llm.complete(
                  modelId,
                  messages as unknown as IMessage[],
                  { stream: false, maxTokens: REFINE_TEXT_MAX_TOKENS },
                  async chunks => {
                    await callback(chunks[0]);
                  }
                );
              },
            },
          }
        );
      } catch (error) {
        if (error === billingRefusal) throw error;
        // Wrapped so v1 can answer 502; the original rides along as `cause`, which the legacy
        // route rethrows (it needs the provider error's numeric `status`) and v1 logs.
        throw new RefineFailedError(error instanceof Error ? error.message : 'Text refinement failed', error);
      }
      // getCachedData stores whatever the producer returns, so an empty output has to throw:
      // cached, it would answer every retry for the whole TTL without calling the model again.
      if (!refined) {
        throw new RefineFailedError('The model returned no refined text');
      }
      return refined;
    },
    {
      db: { caches: cacheRepository },
      expiry: REFINE_TEXT_CACHE_MS,
      logger: req.logger,
    }
  );
};
