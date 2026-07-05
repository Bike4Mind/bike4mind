import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchTaskService } from '@bike4mind/services';
import {
  researchAgentRepository,
  withTransaction,
  researchTaskRepository,
  researchDataRepository,
  taskScheduleRepository,
} from '@bike4mind/database';
import { researchTaskJobs } from '@server/jobs/researchTasks';

const handler = baseApi({ auth: true })
  .get(
    asyncHandler(async (req, res) => {
      const { id } = req.query as any;
      const result = await researchTaskService.listByAgentId(
        req.user as any,
        {
          researchAgentId: id,
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
  .post(
    asyncHandler(async (req, res) => {
      const { id } = req.query as any;
      const result = await researchTaskService.create(
        req.user as any,
        {
          ...(req.body as any),
          researchAgentId: id,
          isPublic: true, // In b4m all files are public for research tasks
        },
        {
          db: {
            transaction: withTransaction,
            researchTasks: researchTaskRepository,
            researchAgents: researchAgentRepository,
            taskSchedules: taskScheduleRepository,
          },
          jobs: {
            researchTasks: researchTaskJobs,
          },
        }
      );

      return res.json(result);
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      const { id } = req.query as any;
      const result = await researchTaskService.remove(
        req.user as any,
        {
          id,
        },
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
