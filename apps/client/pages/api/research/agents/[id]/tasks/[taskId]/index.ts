import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchTaskService } from '@bike4mind/services';
import { researchDataRepository, researchTaskRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const { taskId } = req.query as any;
      const result = await researchTaskService.get(
        req.user as any,
        { id: taskId as any },
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
      const { taskId } = req.query as any;
      const result = await researchTaskService.update(
        req.user as any,
        {
          id: taskId as any,
          ...(req.body as any),
        },
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
      const { taskId } = req.query as any;
      const result = await researchTaskService.remove(
        req.user as any,
        { id: taskId as any },
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
