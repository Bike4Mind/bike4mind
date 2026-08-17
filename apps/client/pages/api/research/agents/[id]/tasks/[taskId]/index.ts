import * as z from 'zod';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchTaskService } from '@bike4mind/services';
import { researchDataRepository, researchTaskRepository } from '@bike4mind/database';
import { ResearchTaskType } from '@bike4mind/common';

const taskIdParamSchema = z.object({ taskId: z.string() });

const taskUpdateBodySchema = z.object({
  title: z.string(),
  description: z.string(),
  type: z.nativeEnum(ResearchTaskType),
  urls: z.array(z.string().url()).min(1).optional(),
  canDiscoverLinks: z.boolean().optional(),
});

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const { taskId } = taskIdParamSchema.parse(req.query);
      const result = await researchTaskService.get(
        req.user as any,
        { id: taskId },
        {
          db: {
            researchTasks: researchTaskRepository,
            researchData: researchDataRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .put(
    asyncHandler(async (req, res) => {
      const { taskId } = taskIdParamSchema.parse(req.query);
      const body = taskUpdateBodySchema.parse(req.body);
      const result = await researchTaskService.update(
        req.user as any,
        { id: taskId, ...body },
        {
          db: {
            researchTasks: researchTaskRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      const { taskId } = taskIdParamSchema.parse(req.query);
      const result = await researchTaskService.remove(
        req.user as any,
        { id: taskId },
        {
          db: {
            researchTasks: researchTaskRepository,
            researchDatas: researchDataRepository,
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
