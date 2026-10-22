import { IMessage } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { refineText } from '@bike4mind/services/llm/refineText';
import { OperationsModelService } from '@client/services/operationsModelService';
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
 * Returns undefined when the model produced no text.
 */
export const refineTextRequest = async (
  { text, context }: { text: string; context?: string },
  { logger }: { logger: Logger }
): Promise<string | undefined> =>
  cacheService.getCachedData(
    CacheKeys.refineText(text, context),
    async () => {
      const { modelId, llm } = await OperationsModelService.getOperationsModel();
      if (!llm) {
        throw new RefineProviderUnavailableError();
      }

      return refineText(
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
    },
    {
      db: { caches: cacheRepository },
      expiry: REFINE_TEXT_CACHE_MS,
      logger,
    }
  );
