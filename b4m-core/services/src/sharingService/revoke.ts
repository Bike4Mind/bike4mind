import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionRepository,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError, secureParameters, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const revokeSharingSchema = z.object({
  id: z.string(),
  type: z.enum(['files', 'sessions', 'projects']),
  userId: z.string(),
  projectId: z.string().optional(),
});

type RevokeSharingParameters = z.infer<typeof revokeSharingSchema>;

interface RevokeSharingAdapters {
  db: {
    sessions: ISessionRepository;
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
    users: IUserRepository;
  };
}

/**
 * Revokes sharing for a user on a document.
 *
 * @param userId - The ID of the user revoking the sharing.
 * @param parameters - The parameters for the revoke sharing operation.
 * @param adapters - The adapters for the database operations.
 * @returns The document after revoking sharing.
 */
export const revoke = async (userId: string, parameters: RevokeSharingParameters, adapters: RevokeSharingAdapters) => {
  const { id, type, userId: userIdToRevoke, projectId } = secureParameters(parameters, revokeSharingSchema);
  const { db } = adapters;

  const dbModels = {
    files: db.fabFiles,
    sessions: db.sessions,
    projects: db.projects,
  };

  const dbModel = dbModels[type];

  const member = await db.users.findById(userIdToRevoke);
  if (!member) throw new NotFoundError(`User not found for id: ${userIdToRevoke}`);
  const document = await dbModel.shareable.findAccessibleById(member, id);
  if (!document) throw new NotFoundError(`${type} not found for ${id}`);

  // Authorization: only the document owner or the user themselves can revoke sharing
  const isOwner = (document as { userId?: string }).userId === userId;
  const isSelfRevoke = userId === userIdToRevoke;
  if (!isOwner && !isSelfRevoke) {
    throw new UnauthorizedError('Only the document owner or the shared user themselves can revoke sharing');
  }

  const userIndex = document.users.findIndex(user => user.userId.toString() === userIdToRevoke);
  if (userIndex === -1) throw new NotFoundError(`User not found in document`);

  if (type === 'projects') {
    document.users = document.users.filter(user => user.userId.toString() !== userIdToRevoke && user.projectId !== id);
    await revokeFromProject({ project: document as IProjectDocument, userIdToRevoke }, adapters);
  } else if (projectId) {
    document.users = document.users.filter(
      user => user.userId.toString() !== userIdToRevoke && user.projectId !== projectId
    );
  } else {
    document.users = document.users.filter(user => user.userId.toString() !== userIdToRevoke);
  }

  await dbModel.update(document);

  return document;
};

export const revokeFromProject = async (
  parameters: { project: IProjectDocument; userIdToRevoke: string },
  adapters: RevokeSharingAdapters
) => {
  const { project, userIdToRevoke } = parameters;
  const { db } = adapters;

  const files = await db.fabFiles.findAllByIds(project.fileIds);
  const sessions = await db.sessions.findAllByIds(project.sessionIds);

  for (const file of files) {
    try {
      // If the file is owned by the user being revoked,
      // we need to revoke the sharing for all other users in the project
      if (file.userId === userIdToRevoke) {
        const usersToBeRevoked = project.users.filter(u => u.userId !== userIdToRevoke);
        for (const user of usersToBeRevoked) {
          await revoke(
            user.userId,
            { id: file.id, type: 'files', userId: user.userId, projectId: project.id },
            adapters
          );
        }

        project.fileIds = project.fileIds.filter(id => id !== file.id);
      } else {
        await revoke(
          file.userId,
          { id: file.id, type: 'files', userId: userIdToRevoke, projectId: project.id },
          adapters
        );
      }
    } catch (e) {
      if (e instanceof NotFoundError && e.message !== 'User not found in document') throw e;
    }
  }

  for (const session of sessions) {
    try {
      // If the session is owned by the user being revoked,
      // we need to revoke the sharing for all other users in the project
      if (session.userId === userIdToRevoke) {
        const usersToBeRevoked = project.users.filter(u => u.userId !== userIdToRevoke);
        for (const user of usersToBeRevoked) {
          await revoke(
            user.userId,
            { id: session.id, type: 'sessions', userId: user.userId, projectId: project.id },
            adapters
          );
        }

        project.sessionIds = project.sessionIds.filter(id => id !== session.id);
      } else {
        await revoke(
          session.userId,
          { id: session.id, type: 'sessions', userId: userIdToRevoke, projectId: project.id },
          adapters
        );
      }
    } catch (e) {
      if (e instanceof NotFoundError && e.message !== 'User not found in document') throw e;
    }
  }
};
