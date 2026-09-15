import { IUserDocument } from '@bike4mind/common';
import { IResearchAgentRepository } from '@bike4mind/common';
import { z } from 'zod';
import { secureParameters } from '@bike4mind/utils';

const researchAgentUpdateSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().min(1),
});

type ResearchAgentUpdateParameters = z.infer<typeof researchAgentUpdateSchema>;

interface ResearchAgentUpdateAdapters {
  db: {
    researchAgents: IResearchAgentRepository;
  };
}

export const update = async (
  user: IUserDocument,
  parameters: ResearchAgentUpdateParameters,
  { db }: ResearchAgentUpdateAdapters
) => {
  const { id, name, description } = secureParameters(parameters, researchAgentUpdateSchema);

  const researchAgent = await db.researchAgents.findByIdAndUserId(id, user.id);

  if (!researchAgent) {
    throw new Error('Research agent not found');
  }

  researchAgent.name = name;
  researchAgent.description = description;
  researchAgent.updatedAt = new Date();

  await db.researchAgents.update(researchAgent);

  return researchAgent;
};
