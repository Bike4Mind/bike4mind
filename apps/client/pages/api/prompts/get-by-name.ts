import { Prompt } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const GetPromptByNameSchema = z.object({
  name: z.string(),
});

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const { name } = GetPromptByNameSchema.parse(req.query);

    const prompt = await Prompt.findOne({
      name,
    });

    return res.json(prompt);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
