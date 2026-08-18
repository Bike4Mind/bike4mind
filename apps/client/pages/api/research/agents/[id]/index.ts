import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchAgentService } from '@bike4mind/services';
import { researchAgentRepository, researchTaskRepository } from '@bike4mind/database';
import * as z from 'zod';

const idParamSchema = z.object({ id: z.string() });
const updateBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const { id } = idParamSchema.parse(req.query);
      const result = await researchAgentService.get(
        req.user as any,
        { id },
        {
          db: {
            researchAgents: researchAgentRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .put(
    asyncHandler(async (req, res) => {
      const { id } = idParamSchema.parse(req.query);
      const body = updateBodySchema.parse(req.body);
      const result = await researchAgentService.update(
        req.user as any,
        { id, ...body },
        {
          db: {
            researchAgents: researchAgentRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const { id } = idParamSchema.parse(req.query);
      const body = updateBodySchema.parse(req.body);
      const result = await researchAgentService.update(
        req.user as any,
        { id, ...body },
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
      const { id } = idParamSchema.parse(req.query);

      const result = await researchAgentService.remove(
        req.user as any,
        { id },
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
