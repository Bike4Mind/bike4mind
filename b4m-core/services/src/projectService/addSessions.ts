import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
  Permission,
  BadRequestError,
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
  // BadRequestError on a PARTIAL resolve, matching addFiles/removeFiles/removeSessions: the
  // repository now skips ids it cannot reach instead of throwing, so without this the endpoint
  // answers 200 having attached only some of the requested notebooks.
  if (sessions.length !== sessionIds.length) {
    throw new BadRequestError('Some sessions are not accessible');
  }

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) {
    throw new NotFoundError('Project not found');
  }

  // The ids that RESOLVED, not the request's raw list - same reason as the fileIds push below.
  // Equivalent to `sessionIds` given the equality check above, and stays correct if that check
  // ever loosens: findAllAccessibleByIds skips entries that cannot address a row, so the raw
  // list could otherwise persist a junk sessionId that the read-side guard then hides.
  project.sessionIds = uniq([...project.sessionIds, ...sessions.map(session => session.id)]);
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
      // The ids that RESOLVED, not the session's raw list, so a legacy unusable id is not copied
      // into project.fileIds and spread to another document. Note this is narrower than "the
      // castable ids": softDeletePlugin adds `deletedAt: null` to the find, so a soft-deleted row
      // is absent too and its id stops being inherited. Pinned in addSessions.fileIds.test.ts.
      fileIds.push(...files.map((file: { id: string }) => file.id));
    }
  }

  return fileIds;
};
