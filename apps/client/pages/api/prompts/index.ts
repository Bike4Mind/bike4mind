// packages/server/api/prompts/index.ts

import { Prompt, promptRepository } from '@bike4mind/database';
import { promptService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import qs from 'qs';
import { z } from 'zod';

const promptAdapters = { db: { prompts: promptRepository } };

const GetPrompsRequestSchema = z.object({
  id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  type: z.string().optional(),
  name: z.string().optional(),
});

const CreatePromptRequestSchema = z.object({
  type: z.string(),
  name: z.string(),
  promptText: z.string(),
  tags: z.array(z.string()).optional(),
});

const handler = baseApi()
  /**
   * GET /api/prompts
   * Get prompts
   */
  .get(
    asyncHandler<unknown, unknown, unknown, Record<string, string>>(async (req, res) => {
      if (!req.ability) {
        throw new NotFoundError('Ability not found');
      }

      // Check permissions for reading prompts
      if (!req.ability.can('read', Prompt)) {
        throw new NotFoundError('Permission denied');
      }

      const { id, tags, type, name } = GetPrompsRequestSchema.parse(qs.parse(req.query));

      if (id) {
        // Get prompt by ID (throws NotFoundError -> 404 when absent)
        const prompt = await promptService.getPrompt({ id }, promptAdapters);
        return res.json(prompt);
      } else if (tags) {
        // Get prompts by tags
        const tagArray = Array.isArray(tags) ? tags : [tags];
        const prompts = await promptService.listPromptByTags({ tags: tagArray }, promptAdapters);
        return res.json(prompts);
      } else if (type) {
        // Get prompts by type
        const prompts = await promptService.listPromptsByTypes({ type }, promptAdapters);
        return res.json(prompts);
      } else if (name) {
        // Get prompts by name
        const prompts = await promptService.listPromptByName({ name }, promptAdapters);
        return res.json(prompts);
      } else {
        // Get all prompts
        const prompts = await Prompt.find();
        return res.json(prompts);
      }
    })
  )
  /**
   * POST /api/prompts
   */
  .post(
    asyncHandler(async (req, res) => {
      const newPromptData = CreatePromptRequestSchema.parse(req.body);
      const { type, name, promptText, tags } = newPromptData;

      const newPrompt = await promptService.createPrompt({ type, name, promptText, tags: tags ?? [] }, promptAdapters);

      return res.status(201).send(newPrompt);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
