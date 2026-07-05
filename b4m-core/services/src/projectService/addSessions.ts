import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
  Permission,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import uniq from 'lodash/uniq.js';
import { pushShareable } from '../sharingService';
import { updateShareableFiles } from './addFiles';

const addSessionsProjectSchema = z.object({
  projectId: z.string().nonempty(),
  sessionIds: z.tuple([z.string()], z.string()),
});

type AddSessionsProjectParameters = z.infer<typeof addSessionsProjectSchema>;

interface AddSessionsProjectAdapters {
  db: {
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const addSessions = async (
  user: IUserDocument,
  params: AddSessionsProjectParameters,
  adapters: AddSessionsProjectAdapters
) => {
  const { db } = adapters;
  const { projectId, sessionIds } = secureParameters(params, addSessionsProjectSchema);

  const sessions = await db.sessions.shareable.findAllAccessibleByIds(user, sessionIds);
  if (sessions.length === 0) {
    throw new NotFoundError('Sessions not found');
  }

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found');
  }

  project.sessionIds = uniq([...project.sessionIds, ...sessionIds]);
  project.updatedAt = new Date();

  const fileIds = await updateShareableSessions(user, { project, sessions }, adapters);
  project.fileIds = uniq([...project.fileIds, ...fileIds]);

  await db.projects.update(project);

  return sessions;
};

const updateShareableSessions = async (
  user: IUserDocument,
  params: { project: IProjectDocument; sessions: ISessionDocument[] },
  adapters: AddSessionsProjectAdapters
) => {
  const { project, sessions } = params;
  const { db } = adapters;

  const fileIds = [];
  for (const session of sessions) {
    if (project.userId !== user.id) {
      pushShareable(session, {
        userId: project.userId,
        permissions: [Permission.read, Permission.update],
        projectId: project.id,
      });
    }

    for (const user of project.users) {
      pushShareable(session, { userId: user.userId, permissions: user.permissions, projectId: project.id });
    }

    await db.sessions.update(session);

    if (session.knowledgeIds && session.knowledgeIds.length > 0) {
      const files = await db.fabFiles.findAllByIds(session.knowledgeIds);

      await updateShareableFiles(user.id, { project, files }, adapters);
      fileIds.push(...session.knowledgeIds);
    }
  }

  return fileIds;
};
