import { Logger } from '@bike4mind/observability';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { ResearchTaskStatus, IResearchTaskRepository, IResearchTaskJobs } from '@bike4mind/common';
import { z } from 'zod';

const researchTaskRetrySchema = z.object({
  id: z.string(),
  userId: z.string(),
});

type ResearchTaskRetryParameters = z.infer<typeof researchTaskRetrySchema>;

interface ResearchTaskRetryAdapters {
  db: {
    transaction: <T>(fn: () => Promise<T>) => Promise<T>;
    researchTasks: IResearchTaskRepository;
  };
  jobs: {
    researchTasks: IResearchTaskJobs;
  };
}

export const retry = async (parameters: ResearchTaskRetryParameters, adapters: ResearchTaskRetryAdapters) => {
  const { db, jobs } = adapters;
  const { id, userId } = secureParameters(parameters, researchTaskRetrySchema);

  const researchTask = await db.transaction(async () => {
    const researchTask = await db.researchTasks.findByIdAndUserId(id, userId);

    if (!researchTask) {
      throw new NotFoundError('Research task not found');
    }

    if (researchTask.status === ResearchTaskStatus.PROCESSING) {
      Logger.globalInstance.log(`⚠️ [FORCE_RETRY] Force retrying stuck task ${researchTask.id} from PROCESSING state`);
    }

    researchTask.status = ResearchTaskStatus.PROCESSING;
    researchTask.statusFailedAt = null;
    researchTask.statusFailedMessage = null;
    await db.researchTasks.update(researchTask);

    Logger.globalInstance.log(`🔄 [RETRY_RESET] Task ${researchTask.id} status reset to PROCESSING for retry`);

    return researchTask;
  });

  await jobs.researchTasks.process(researchTask.id, userId);

  return researchTask;
};
