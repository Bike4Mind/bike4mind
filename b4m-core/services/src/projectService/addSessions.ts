import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
  Permission,
  BadRequestError,
  NotFoundError,
  secureParameters,
} from '@bike4mind/common';
import { z } from 'zod';
import { pushShareable } from '../sharingService';
import { distinctIdCount, mergeIds } from '../utils/objectIds';
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

  // Resolved before the session guards so a bad projectId answers 404 'Project not found' rather
  // than reporting the sessions as inaccessible.
  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found');
  }

  const sessions = await db.sessions.shareable.findAllAccessibleByIds(user, sessionIds);
  if (sessions.length === 0) {
    throw new NotFoundError('Sessions not found');
  }
  // Partial resolve is a 400; all-missing keeps the 404 above. See addFiles. Counted as DISTINCT
  // rows ignoring hex case: the reader returns one row per document, so the same notebook sent
  // twice - or sent as both `abc` and `ABC` - is not one that could not be reached.
  if (sessions.length !== distinctIdCount(sessionIds)) throw new BadRequestError('Some sessions are not accessible');

  // The ids that RESOLVED, not the request's raw list - same reason as the fileIds push below.
  project.sessionIds = mergeIds(
    project.sessionIds,
    sessions.map(session => session.id)
  );
  project.updatedAt = new Date();

  const fileIds = await updateShareableSessions(user, { project, sessions }, adapters);
  project.fileIds = mergeIds(project.fileIds, fileIds);

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
      // The ids that RESOLVED, not the session's raw list, so a legacy unusable id is not copied
      // into project.fileIds and spread to another document. Note this is narrower than "the
      // castable ids": softDeletePlugin adds `deletedAt: null` to the find, so a soft-deleted row
      // is absent too and its id stops being inherited. Pinned in addSessions.fileIds.test.ts.
      fileIds.push(...files.map((file: { id: string }) => file.id));
    }
  }

  return fileIds;
};
