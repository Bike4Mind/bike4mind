import { IFabFileRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { IResearchAgentRepository, IResearchDataRepository } from '@bike4mind/common';
import { z } from 'zod';

const researchAgentListFilesSchema = z.object({
  id: z.string(),
});

type ResearchAgentListFilesParameters = z.infer<typeof researchAgentListFilesSchema>;

interface ResearchAgentListFilesAdapters {
  db: {
    researchAgents: IResearchAgentRepository;
    researchDatas: IResearchDataRepository;
    fabFiles: Pick<IFabFileRepository, 'findAllByIds'>;
  };
}

export const listFiles = async (
  user: { id: string },
  parameters: ResearchAgentListFilesParameters,
  { db }: ResearchAgentListFilesAdapters
) => {
  const { id } = secureParameters(parameters, researchAgentListFilesSchema);

  const researchAgent = await db.researchAgents.findByIdAndUserId(id, user.id);

  if (!researchAgent) {
    throw new NotFoundError('Research agent not found');
  }

  const researchData = await db.researchDatas.findAllByResearchAgentId(researchAgent.id);

  const files = await db.fabFiles.findAllByIds(researchData.map(d => d.fabFileId));

  return files;
};
