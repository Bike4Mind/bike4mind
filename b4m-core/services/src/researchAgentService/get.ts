import { IResearchAgentRepository } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const researchAgentGetSchema = z.object({
  id: z.string(),
});

type ResearchAgentGetParameters = z.infer<typeof researchAgentGetSchema>;

interface ResearchAgentGetAdapters {
  db: {
    researchAgents: IResearchAgentRepository;
  };
}

export const get = async (
  user: IUserDocument,
  parameters: ResearchAgentGetParameters,
  { db }: ResearchAgentGetAdapters
) => {
  const { id } = secureParameters(parameters, researchAgentGetSchema);

  const researchAgent = await db.researchAgents.findByIdAndUserId(id, user.id);

  if (!researchAgent) {
    throw new Error('Research agent not found');
  }

  return researchAgent;
};
