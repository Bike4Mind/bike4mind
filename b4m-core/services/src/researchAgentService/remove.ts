import { IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { IResearchAgentRepository, IResearchTaskRepository } from '@bike4mind/common';
import { z } from 'zod';

const researchAgentRemoveSchema = z.object({
  id: z.string(),
});

type ResearchAgentRemoveParameters = z.infer<typeof researchAgentRemoveSchema>;

interface ResearchAgentRemoveAdapters {
  db: {
    researchAgents: IResearchAgentRepository;
    researchTasks: IResearchTaskRepository;
  };
}

export const remove = async (
  user: IUserDocument,
  parameters: ResearchAgentRemoveParameters,
  { db }: ResearchAgentRemoveAdapters
) => {
  const { id } = secureParameters(parameters, researchAgentRemoveSchema);

  const researchAgent = await db.researchAgents.findByIdAndUserId(id, user.id);

  if (!researchAgent) {
    throw new Error('Research agent not found');
  }

  researchAgent.deletedAt = new Date();

  await db.researchAgents.update(researchAgent);

  await db.researchTasks.updateManyByResearchAgentId(id, {
    deletedAt: new Date(),
  });

  return researchAgent;
};
