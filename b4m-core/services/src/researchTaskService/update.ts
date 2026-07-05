import { secureParameters, UnprocessableEntityError } from '@bike4mind/utils';
import { IResearchTaskRepository, ResearchTaskStatus, ResearchTaskType, IResearchTask } from '@bike4mind/common';
import { z } from 'zod';
import { IUserDocument } from '@bike4mind/common';

const updateResearchTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.enum(ResearchTaskType),
});

const researchTaskScrapeUpdateSchema = updateResearchTaskSchema.extend({
  urls: z.array(z.url()).min(1),
  canDiscoverLinks: z.boolean(),
});

type UpdateResearchTaskParameters = z.infer<typeof updateResearchTaskSchema>;

interface UpdateResearchTaskAdapters {
  db: {
    researchTasks: IResearchTaskRepository;
  };
}

export const update = async (
  user: IUserDocument,
  parameters: UpdateResearchTaskParameters,
  adapters: UpdateResearchTaskAdapters
): Promise<IResearchTask> => {
  const { id, title, description } = secureParameters(parameters, updateResearchTaskSchema);

  const researchTask = await adapters.db.researchTasks.findByIdAndUserId(id, user.id);

  if (!researchTask) {
    throw new Error('Research task not found');
  }

  if (researchTask.status === ResearchTaskStatus.PROCESSING) {
    throw new UnprocessableEntityError('Cannot update a research task that is currently processing');
  }

  researchTask.title = title;
  researchTask.description = description;

  if (researchTask.type === ResearchTaskType.SCRAPE) {
    const { urls, canDiscoverLinks } = secureParameters(parameters, researchTaskScrapeUpdateSchema);
    researchTask.urls = urls;
    researchTask.canDiscoverLinks = canDiscoverLinks;
  }

  await adapters.db.researchTasks.update(researchTask);

  return researchTask;
};
