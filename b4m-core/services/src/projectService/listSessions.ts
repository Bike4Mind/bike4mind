import { IProjectRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listProjectSessionsSchema = z.object({
  projectId: z.string(),
});

type ListProjectSessionsParameters = z.infer<typeof listProjectSessionsSchema>;

interface ListProjectSessionsAdapters {
  db: {
    projects: IProjectRepository;
    sessions: ISessionRepository;
    users: IUserRepository;
  };
}

export const listSessions = async (
  userId: string,
  params: ListProjectSessionsParameters,
  adapters: ListProjectSessionsAdapters
) => {
  const { projectId } = secureParameters(params, listProjectSessionsSchema);

  const user = await adapters.db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const project = await adapters.db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const sessions = await adapters.db.sessions.findAllByIds(project.sessionIds);

  return sessions;
};
