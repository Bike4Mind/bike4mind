import { IUserDocument } from '@bike4mind/common';
import { IResearchAgentRepository } from '@bike4mind/common';

interface ResearchAgentListAdapters {
  db: {
    researchAgents: IResearchAgentRepository;
  };
}

/** List all research agents for a user. */
export const list = async (user: IUserDocument, { db }: ResearchAgentListAdapters) => {
  const researchAgents = await db.researchAgents.findAllByUserId(user.id);

  return researchAgents;
};
