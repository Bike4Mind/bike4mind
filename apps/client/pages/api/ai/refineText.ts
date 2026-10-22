import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { refineTextLLMSchema } from '@bike4mind/services/llm/refineText';
import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { refineTextRequest } from '@server/ai/refineTextRequest';
import { z } from 'zod';

// POST (not GET): this triggers an LLM completion, so it isn't a safe/idempotent
// read. Gated to ai:generate so an under-scoped API key can't drive LLM cost.
// Legacy route for the SPA; the documented public equivalent is POST /api/v1/text-refinements.
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

    const enhancedText = await refineTextRequest(params, { logger: req.logger });

    res.json({ text: enhancedText });
  })
);

export default handler;
