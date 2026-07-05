import { IProjectDocument, IProjectRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sessionIds: z.array(z.string()).optional(),
  fileIds: z.array(z.string()).optional(),
});

type CreateProjectParameters = z.infer<typeof createProjectSchema>;

interface CreateProjectAdapters {
  db: {
    projects: Pick<IProjectRepository, 'create'>;
  };
}

export const createProject = async (
  userId: string,
  params: CreateProjectParameters,
  adapters: CreateProjectAdapters
) => {
  const { db } = adapters;
  const { name, description, sessionIds, fileIds } = secureParameters(params, createProjectSchema);

  const buildProject: Omit<IProjectDocument, 'id'> = {
    name,
    description,
    userId,

    sessionIds: sessionIds || [],
    fileIds: fileIds || [],
    systemPrompts: [],

    isGlobalRead: false,
    isGlobalWrite: false,
    users: [],
    groups: [],

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const project = await db.projects.create(buildProject);

  return project;
};
