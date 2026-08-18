import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { refineText, refineTextLLMSchema, cacheService } from '@bike4mind/services';
import { IMessage, ApiKeyScope } from '@bike4mind/common';
import { cacheRepository } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { OperationsModelService } from '@client/services/operationsModelService';
import { CacheKeys } from '@server/utils/cacheKeys';
import { z } from 'zod';

// Identical (text, context) refinements are common (users re-clicking refine),
// and every miss is a paid operations-model call - cache briefly.
const REFINE_TEXT_CACHE_MS = 5 * 60 * 1000;
// Cap output so one refine can't run away; refined text is short by nature.
const REFINE_TEXT_MAX_TOKENS = 800;

// POST (not GET): this triggers an LLM completion, so it isn't a safe/idempotent
// read. Gated to ai:generate so an under-scoped API key can't drive LLM cost.
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).post(
  asyncHandler(async (req, res) => {
    let params: z.infer<typeof refineTextLLMSchema>;
    try {
      params = refineTextLLMSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestError(err.issues[0]?.message ?? 'Invalid request body');
      }
      throw err;
    }
    const { text, context } = params;

    const enhancedText = await cacheService.getCachedData(
      CacheKeys.refineText(text, context),
      async () => {
        const { modelId, llm } = await OperationsModelService.getOperationsModel();
        if (!llm) {
          throw new Error('Failed to initialize LLM');
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
        logger: req.logger,
      }
    );

    res.json({ text: enhancedText });
  })
);

export default handler;
