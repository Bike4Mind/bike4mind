import { revokeFromProject } from '../sharingService';
import {
  IFabFileRepository,
  IProjectRepository,
  ISessionRepository,
  IUserDocument,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError, UnauthorizedError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

export const leaveProjectParamsSchema = z.object({
  id: z.string(),
  userIdToRemove: z.string().optional(), // Optional: if provided, this is a removal by owner
});

type LeaveProjectParameters = z.infer<typeof leaveProjectParamsSchema>;

interface LeaveProjectAdapters {
  db: {
    projects: IProjectRepository;
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    users: IUserRepository;
  };
}

export const leaveProject = async (
  user: IUserDocument,
  params: LeaveProjectParameters,
  adapters: LeaveProjectAdapters
) => {
  const { id: projectId, userIdToRemove } = secureParameters(params, leaveProjectParamsSchema);
  const isOwnerRemovingMember = !!userIdToRemove;

  const project = await adapters.db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) {
    throw new NotFoundError(`Project not found for id ${projectId}`);
  }

  // If owner is removing a member
  if (isOwnerRemovingMember) {
    if (project.userId !== user.id) {
      throw new UnauthorizedError('Only project owner can remove members');
    }

    const memberExists = project.users.some(u => u.userId === userIdToRemove);
    if (!memberExists) {
      throw new NotFoundError(`User not found in project`);
    }

    project.users = project.users.filter(u => u.userId !== userIdToRemove);
    await revokeFromProject({ project, userIdToRevoke: userIdToRemove }, adapters);
  } else {
    // User is leaving voluntarily
    if (project.userId === user.id) {
      throw new UnauthorizedError('Project owner cannot leave their own project');
    }
    project.users = project.users.filter(u => u.userId !== user.id);
    await revokeFromProject({ project, userIdToRevoke: user.id }, adapters);
  }

  await adapters.db.projects.update(project);

  return project;
};
