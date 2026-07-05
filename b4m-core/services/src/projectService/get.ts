import { IProjectRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const getProjectSchema = z.object({
  id: z.string(),
});

type GetProjectParameters = z.infer<typeof getProjectSchema>;

interface GetProjectAdapters {
  db: {
    projects: IProjectRepository;
    users: IUserRepository;
  };
}

export const get = async (userId: string, parameters: GetProjectParameters, adapters: GetProjectAdapters) => {
  const { db } = adapters;
  const { id } = secureParameters(parameters, getProjectSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const project = await db.projects.shareable.findAccessibleById(user, id);
  if (!project) throw new NotFoundError('Project not found');

  return project;
};
