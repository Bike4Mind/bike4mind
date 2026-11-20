import { IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { IResearchDataRepository, IResearchTaskRepository, IResearchTaskWithData } from '@bike4mind/common';
import { z } from 'zod';
import { generateSignedUrl, type GetFabFileAdapter } from '../fabFileService/get';

const getResearchTaskSchema = z.object({
  id: z.string().min(1),
});

type GetResearchTaskParameters = z.infer<typeof getResearchTaskSchema>;

interface GetResearchTaskAdapters {
  db: {
    researchTasks: IResearchTaskRepository;
    researchData: IResearchDataRepository;
  };
  storage: GetFabFileAdapter['storage'];
}

export const get = async (
  user: IUserDocument,
  parameters: GetResearchTaskParameters,
  adapters: GetResearchTaskAdapters
): Promise<IResearchTaskWithData> => {
  const { id } = secureParameters(parameters, getResearchTaskSchema);

  const researchTask = await adapters.db.researchTasks.findByIdAndUserId(id, user.id);

  if (!researchTask) {
    throw new Error('Research task not found');
  }

  const researchData = await adapters.db.researchData.findAllByResearchTaskIdWithFiles(researchTask.id);

  const signedResearchData = await Promise.all(
    researchData.map(async data => ({
      ...data,
      fabFile: await generateSignedUrl(data.fabFile, { storage: adapters.storage } as GetFabFileAdapter),
    }))
  );

  return {
    ...researchTask,
    researchData: signedResearchData,
  };
};
