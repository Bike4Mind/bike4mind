import { IProjectRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const deleteProjectSchema = z.object({
  id: z.string(),
});

type DeleteProjectParameters = z.infer<typeof deleteProjectSchema>;

interface DeleteProjectAdapters {
  db: {
    projects: IProjectRepository;
  };
}

export const deleteProject = async (
  userId: string,
  parameters: DeleteProjectParameters,
  adapters: DeleteProjectAdapters
) => {
  const { db } = adapters;
  const { id } = secureParameters(parameters, deleteProjectSchema);

  const project = await db.projects.findByIdAndUserId(id, userId);

  if (!project) {
    throw new NotFoundError('Project not found');
  }

  project.deletedAt = new Date();
  project.name = `[Deleted] ${project.id}`;

  await db.projects.update(project);

  return project;
};
