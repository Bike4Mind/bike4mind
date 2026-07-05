import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchAgentService } from '@bike4mind/services';
import { researchAgentRepository } from '@bike4mind/database';

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
      const result = await researchAgentService.create(req.user as any, req.body as any, {
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
