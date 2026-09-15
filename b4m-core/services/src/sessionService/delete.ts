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
  const fabFiles = await db.fabFiles.find({ sessionId: session.id });
  await db.fabFiles.deleteManyInIds(fabFiles.map(f => f.id));
  const mostRecent = await db.sessions.findRecentlyUpdatedByUserId(userId);

  return mostRecent;
};
