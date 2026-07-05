import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchAgentService } from '@bike4mind/services';
import { researchAgentRepository, researchTaskRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const result = await researchAgentService.get(req.user as any, req.body as any, {
        db: {
          researchAgents: researchAgentRepository,
        },
      });

      return res.json(result);
    })
  )
  .put(
    asyncHandler(async (req, res) => {
      const result = await researchAgentService.update(req.user as any, req.body as any, {
        db: {
          researchAgents: researchAgentRepository,
        },
      });

      return res.json(result);
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const result = await researchAgentService.update(
        req.user as any,
        {
          ...(req.query as any),
          ...(req.body as any),
        },
        {
          db: {
            researchAgents: researchAgentRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      const { id } = req.query as any;

      const result = await researchAgentService.remove(
        req.user as any,
        {
          id,
        },
        {
          db: {
            researchAgents: researchAgentRepository,
            researchTasks: researchTaskRepository,
          },
        }
      );

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
