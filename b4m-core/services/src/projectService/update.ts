import { Logger } from '@bike4mind/observability';
import { IProjectRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const updateProjectSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

type UpdateProjectParameters = z.infer<typeof updateProjectSchema>;

interface UpdateProjectAdapters {
  db: {
    projects: IProjectRepository;
  };
}

export const update = async (userId: string, parameters: UpdateProjectParameters, adapters: UpdateProjectAdapters) => {
  const { db } = adapters;
  const { id, ...updatedFields } = secureParameters(parameters, updateProjectSchema);

  const project = await db.projects.findByIdAndUserId(id, userId);

  if (!project) {
    throw new NotFoundError('Project not found');
  }

  const updatedProject = {
    ...project,
    ...updatedFields,

    updatedAt: new Date(),
  };
  Logger.globalInstance.log('updatedProject1', updatedProject, '123');

  await db.projects.update(updatedProject);

  return updatedProject;
};
