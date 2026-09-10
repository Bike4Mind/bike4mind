import { IFabFileRepository, IProjectRepository, ISessionRepository } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const deleteSessionSchema = z.object({
  id: z.string(),
});

type DeleteSessionParameters = z.infer<typeof deleteSessionSchema>;

interface DeleteSessionAdapters {
  db: {
    sessions: ISessionRepository;
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
  };
}

export const deleteSession = async (
  userId: string,
  parameters: DeleteSessionParameters,
  adapters: DeleteSessionAdapters
) => {
  const { db } = adapters;
  const { id } = secureParameters(parameters, deleteSessionSchema);

  const session = await db.sessions.findByIdAndUserId(id, userId);

  if (!session) {
    throw new NotFoundError('Session not found');
  }

  session.deletedAt = new Date();

  await db.sessions.update(session);
  await db.projects.removeSession(session.id);

  // A shared session can carry files another collaborator uploaded into it - those are theirs,
  // not the session owner's. Deleting the session must only destroy the owner's own files;
  // an attached file owned by someone else just loses the owner's derived grant, mirroring the
  // owned-vs-shared-in split in DELETE /api/files.
  const fabFiles = await db.fabFiles.find({ sessionId: session.id });
  const ownedFiles = fabFiles.filter(file => file.userId === userId);
  const sharedInFiles = fabFiles.filter(file => file.userId !== userId);

  await db.fabFiles.deleteManyInIds(ownedFiles.map(f => f.id));
  for (const file of sharedInFiles) {
    file.users = file.users.filter(user => user.userId.toString() !== userId);
    await db.fabFiles.update(file);
  }

  const mostRecent = await db.sessions.findRecentlyUpdatedByUserId(userId);

  return mostRecent;
};
