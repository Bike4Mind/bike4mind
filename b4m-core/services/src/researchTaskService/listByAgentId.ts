import { IResearchTaskRepository } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { z } from 'zod';
import { secureParameters } from '@bike4mind/utils';

const listByAgentIdSchema = z.object({
  researchAgentId: z.string(),
});

type ListByAgentIdParameters = z.infer<typeof listByAgentIdSchema>;

interface ResearchTaskListAdapters {
  db: {
    researchTasks: IResearchTaskRepository;
  };
}

export const listByAgentId = async (
  user: IUserDocument,
  parameters: ListByAgentIdParameters,
  { db }: ResearchTaskListAdapters
) => {
  const { researchAgentId } = secureParameters(parameters, listByAgentIdSchema);

  const researchTasks = await db.researchTasks.findAllByUserIdAndResearchAgentId(user.id, researchAgentId);

  return researchTasks;
};
