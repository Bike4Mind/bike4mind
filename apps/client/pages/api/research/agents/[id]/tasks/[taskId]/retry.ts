import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { researchTaskService } from '@bike4mind/services';
import { researchTaskJobs } from '@server/jobs/researchTasks';
import { researchTaskRepository, withTransaction } from '@bike4mind/database';

const handler = baseApi({ auth: true }).post(
  asyncHandler(async (req, res) => {
    const { taskId } = req.query as any;
    const result = await researchTaskService.retry(
      { id: taskId, userId: req.user.id },
      {
        db: {
          transaction: withTransaction,
          researchTasks: researchTaskRepository,
        },
        jobs: {
          researchTasks: researchTaskJobs,
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
