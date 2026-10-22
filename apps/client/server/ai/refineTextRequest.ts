import { IMessage } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { refineText } from '@bike4mind/services/llm/refineText';
import { OperationsModelService, OperationsModelUnavailableError } from '@client/services/operationsModelService';
import { CacheKeys } from '@server/utils/cacheKeys';

// Identical (text, context) refinements are common (users re-clicking refine),
// and every miss is a paid operations-model call - cache briefly.
const REFINE_TEXT_CACHE_MS = 5 * 60 * 1000;
// Cap output so one refine can't run away; refined text is short by nature.
const REFINE_TEXT_MAX_TOKENS = 800;

/** Thrown when no operations LLM can be initialised, so callers can map it to their own status. */
export class RefineProviderUnavailableError extends Error {
  constructor() {
    super('Failed to initialize LLM');
    this.name = 'RefineProviderUnavailableError';
  }
}

/**
 * Cached operations-model refinement shared by POST /api/ai/refineText and POST /api/v1/text-refinements.
 * Throws RefineProviderUnavailableError when the deployment has no operations text model, and on an
 * empty model output (an empty refinement is a failure, and must not be cached).
 */
export const refineTextRequest = async (
  { text, context }: { text: string; context?: string },
  { logger }: { logger: Logger }
): Promise<string> =>
  cacheService.getCachedData(
    CacheKeys.refineText(text, context),
    async () => {
      let operationsModel;
      try {
        operationsModel = await OperationsModelService.getOperationsModel();
      } catch (error) {
        // getOperationsModel never returns a null llm - it throws when it cannot resolve
        // one, which is the same deployment state the public route calls provider_not_configured.
        if (error instanceof OperationsModelUnavailableError) {
          throw new RefineProviderUnavailableError();
        }
        throw error;
      }
      const { modelId, llm } = operationsModel;

      const refined = await refineText(
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
      // getCachedData stores whatever the producer returns, so an empty output has to throw:
      // cached, it would answer every retry for the whole TTL without calling the model again.
      if (!refined) {
        throw new Error('The model returned no refined text');
      }
      return refined;
    },
    {
      db: { caches: cacheRepository },
      expiry: REFINE_TEXT_CACHE_MS,
      logger,
    }
  );
