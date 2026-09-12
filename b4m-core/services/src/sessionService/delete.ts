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

  // A shared session can carry files another collaborator uploaded into it - those are theirs,
  // not the session owner's. Deleting the session must only destroy the owner's own files;
  // an attached file owned by someone else just loses the owner's derived grant, mirroring the
  // owned-vs-shared-in split in DELETE /api/files.
  const fabFiles = await db.fabFiles.find({ sessionId: session.id });
  const ownedFiles = fabFiles.filter(file => file.userId === userId);
  const sharedInFiles = fabFiles.filter(file => file.userId !== userId);

  // Cascade BEFORE the tombstone. softDeletePlugin puts `deletedAt: null` on every findOne, and
  // findByIdAndUserId is a bare findOne, so a session tombstoned first is unreachable on a retry:
  // the guard above would throw and any grant this loop had not yet reached would stay live with
  // no surface left to clear it. Nothing here is transactional, so ordering is the whole defence.
  for (const file of sharedInFiles) {
    // Only the grant this session materialized: an untagged row. A projectId-tagged row is
    // governed by that project and survives the session going away, matching the same
    // qualification in sharingService/revoke.ts's knowledge-file cascade.
    file.users = file.users.filter(user => !(user.userId.toString() === userId && !user.projectId));
    // Whole-doc grant write on a revocation path, so it takes the version guard for the same
    // reason sharingService/revoke.ts does: a racing guarded write must conflict, not clobber.
    await db.fabFiles.updateGuarded!(file);
  }

  session.deletedAt = new Date();

  await db.sessions.update(session);
  await db.projects.removeSession(session.id);

  await db.fabFiles.deleteManyInIds(ownedFiles.map(f => f.id));

  const mostRecent = await db.sessions.findRecentlyUpdatedByUserId(userId);

  return mostRecent;
};
