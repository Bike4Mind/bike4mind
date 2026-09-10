import { IFabFileRepository, IProjectRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { revokeFromProject } from '../sharingService';

const deleteProjectSchema = z.object({
  id: z.string(),
});

type DeleteProjectParameters = z.infer<typeof deleteProjectSchema>;

interface DeleteProjectAdapters {
  db: {
    projects: IProjectRepository;
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    users: IUserRepository;
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

  // Every member's file/session access is a projectId-scoped grant (see pushShareable in
  // sharingService/accept.ts); once the project is gone that grant must go too, or a former
  // member keeps reading the owner's notebooks and files. Reuses the same per-member cascade
  // leaveProject.ts uses, just for every member instead of one.
  for (const member of project.users) {
    await revokeFromProject({ project, userIdToRevoke: member.userId }, adapters);
  }

  project.deletedAt = new Date();
  project.name = `[Deleted] ${project.id}`;

  await db.projects.update(project);

  return project;
};
