import { Prompt, promptRepository } from '@bike4mind/database';
import { promptService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { respond } from '@server/utils/respond';
import { promptResponseSchema } from '@bike4mind/common';
import { z } from 'zod';

const UpdatePromptRequestSchema = z.object({
  type: z.string().optional(),
  promptText: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    // Single source of truth for the Prompt permission model - see ability.ts
    // (matches the pattern already used by GET /api/prompts and DELETE
    // /api/prompts/[id]/delete; this route used to have its own separate,
    // inconsistent 'Analyst'-tag check).
    if (!req.ability) {
      throw new NotFoundError('Ability not found');
    }
    if (!req.ability.can('update', Prompt)) {
      throw new NotFoundError('Permission denied');
    }

    const updateData = UpdatePromptRequestSchema.parse(req.body);

    const updatedPrompt = await promptService.updatePrompt(
      { id, ...updateData },
      { db: { prompts: promptRepository } }
    );

    return respond(res, promptResponseSchema, updatedPrompt);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
