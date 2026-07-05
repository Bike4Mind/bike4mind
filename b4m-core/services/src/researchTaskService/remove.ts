import { IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { IResearchDataRepository, IResearchTaskRepository } from '@bike4mind/common';
import { z } from 'zod';

export const researchTaskRemoveSchema = z.object({
  id: z.string().min(1),
});

type ResearchTaskRemoveParameters = z.infer<typeof researchTaskRemoveSchema>;

interface ResearchTaskRemoveAdapters {
  db: {
    researchTasks: IResearchTaskRepository;
    researchDatas: IResearchDataRepository;
  };
}

export const remove = async (
  user: IUserDocument,
  parameters: ResearchTaskRemoveParameters,
  adapters: ResearchTaskRemoveAdapters
) => {
  const { id } = secureParameters(parameters, researchTaskRemoveSchema);

  const { db } = adapters;

  const researchTask = await db.researchTasks.findByIdAndUserId(id, user.id);

  if (!researchTask) {
    throw new NotFoundError('Research task not found');
  }

  researchTask.deletedAt = new Date();

  await db.researchTasks.update(researchTask);

  await db.researchDatas.deleteAllByResearchTaskId(id);

  return researchTask;
};
