import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchAgentService } from '@bike4mind/services';
import { researchAgentRepository } from '@bike4mind/database';
import * as z from 'zod';

const createBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const result = await researchAgentService.list(req.user as any, {
        db: {
          researchAgents: researchAgentRepository,
        },
      });

      return res.json(result);
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const body = createBodySchema.parse(req.body);
      const result = await researchAgentService.create(req.user as any, body, {
        db: {
          researchAgents: researchAgentRepository,
        },
      });

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
