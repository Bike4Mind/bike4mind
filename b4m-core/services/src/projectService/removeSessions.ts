import { IProjectRepository, ISessionRepository, IUserRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const removeProjectSessionsSchema = z.object({
  projectId: z.string(),
  sessionIds: z.array(z.string()),
});

type RemoveProjectSessionsParameters = z.infer<typeof removeProjectSessionsSchema>;

interface RemoveProjectSessionsAdapters {
  db: {
    projects: IProjectRepository;
    sessions: ISessionRepository;
    users: IUserRepository;
  };
}

export const removeSessions = async (
  userId: string,
  params: RemoveProjectSessionsParameters,
  adapters: RemoveProjectSessionsAdapters
) => {
  const { db } = adapters;
  const { projectId, sessionIds } = secureParameters(params, removeProjectSessionsSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new Error('User not found');

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const sessions = await db.sessions.shareable.findAllAccessibleByIds(user, sessionIds);
  if (sessions.length !== sessionIds.length) throw new Error('Some sessions are not accessible');
  if (project.userId !== userId && sessions.some(s => s.userId !== userId)) {
    throw new Error('You are not authorized to remove sessions from this project');
  }

  project.sessionIds = project.sessionIds.filter(id => !sessionIds.includes(id));
  project.updatedAt = new Date();

  // Revoke all project users access to the session
  for (const session of sessions) {
    session.users = session.users.filter(u => u.projectId !== project.id);
    await db.sessions.update(session);
  }

  await db.projects.update(project);

  return project;
};
