import { z } from 'zod';
import { IResearchAgent, IResearchAgentRepository } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';

const researchAgentCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

type ResearchAgentCreateParameters = z.infer<typeof researchAgentCreateSchema>;

interface ResearchAgentCreateAdapters {
  db: {
    researchAgents: IResearchAgentRepository;
  };
}

export const create = async (
  user: IUserDocument,
  parameters: ResearchAgentCreateParameters,
  { db }: ResearchAgentCreateAdapters
) => {
  const { name, description } = secureParameters(parameters, researchAgentCreateSchema);

  const buildData: Omit<IResearchAgent, 'id'> = {
    name,
    description,
    userId: user.id,

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const researchAgent = await db.researchAgents.create(buildData);

  return researchAgent;
};
