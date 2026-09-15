import {
  IOrganizationRepository,
  IResearchAgentRepository,
  IResearchDataRepository,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { DeleteFabFileAdapter } from '../fabFileService';
import { deleteFabFile } from '../fabFileService/delete';

const researchDataRemoveSchema = z.object({
  id: z.string(),
  researchAgentId: z.string(),
});

type ResarchDataRemoveParams = z.infer<typeof researchDataRemoveSchema>;

type ResearchDataRemoveAdapters = DeleteFabFileAdapter & {
  db: {
    researchDatas: Pick<IResearchDataRepository, 'delete' | 'findByIdAndResearchAgentId'>;
    researchAgents: Pick<IResearchAgentRepository, 'findByIdAndUserId'>;
    organizations: Pick<IOrganizationRepository, 'incrementCurrentStorage'>;
    users: Pick<IUserRepository, 'incrementCurrentStorage'>;
  };
};

export const remove = async (
  userId: string,
  parameters: ResarchDataRemoveParams,
  adapters: ResearchDataRemoveAdapters
) => {
  const { id, researchAgentId } = secureParameters(parameters, researchDataRemoveSchema);

  const researchAgent = await adapters.db.researchAgents.findByIdAndUserId(researchAgentId, userId);

  if (!researchAgent) {
    throw new NotFoundError('Research data not found');
  }

  const researchData = await adapters.db.researchDatas.findByIdAndResearchAgentId(id, researchAgentId);

  if (!researchData) {
    throw new NotFoundError('Research data not found');
  }

  await adapters.db.researchDatas.delete(id);

  // Delete the associated FabFile if it exists and belongs to this user.
  // Gate storage decrement on deleteFabFile's return to avoid double-deduction
  // if the file was already soft-deleted by a concurrent request.
  const result = await deleteFabFile(userId, { id: researchData.fabFileId }, adapters);
  if (result.action === 'deleted' && result.fabFile) {
    if (result.fabFile.organizationId) {
      await adapters.db.organizations.incrementCurrentStorage(result.fabFile.organizationId, -result.fabFile.fileSize);
    } else {
      await adapters.db.users.incrementCurrentStorage(result.fabFile.userId, -result.fabFile.fileSize);
    }
  }
};
