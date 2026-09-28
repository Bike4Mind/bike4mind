import {
  IFabFileRepository,
  IProjectRepository,
  ISessionRepository,
  ISessionAgentConfigRepository,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { bestEffortAdjustOwnerStorage, groupStorageDeltaByOwner } from '../dataLakeService/ports';

const deleteSessionSchema = z.object({
  id: z.string(),
});

type DeleteSessionParameters = z.infer<typeof deleteSessionSchema>;

interface DeleteSessionAdapters {
  db: {
    sessions: ISessionRepository;
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
    // Optional for the same published-signature reason as `sessionAgentConfigs` below. A caller
    // that omits it gets no storage debit, leaving the owner's quota over-counted until the admin
    // recalculate-storage endpoint runs - so every in-repo route must wire it.
    users?: Pick<IUserRepository, 'incrementCurrentStorage'>;
    // Optional: this is a published, patch-released signature (re-exported from
    // @bike4mind/services), so an existing caller built against the pre-cleanup shape must keep
    // compiling and running without it - the cleanup below is then just skipped for that caller.
    sessionAgentConfigs?: ISessionAgentConfigRepository;
  };
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
}

export const deleteSession = async (
  userId: string,
  parameters: DeleteSessionParameters,
  adapters: DeleteSessionAdapters
) => {
  const { db, logger } = adapters;
  const { id } = secureParameters(parameters, deleteSessionSchema);

  const session = await db.sessions.findByIdAndUserId(id, userId);

  if (!session) {
    throw new NotFoundError('Session not found');
  }

  // A shared session can carry files another collaborator uploaded into it - those are theirs, not
  // the session owner's. Deleting the session destroys only the owner's own files, mirroring the
  // owned-vs-shared-in split in DELETE /api/files; anything else just loses the grants this session
  // minted on it.
  const fabFiles = await db.fabFiles.find({ sessionId: session.id });
  const ownedFiles = fabFiles.filter(file => file.userId === userId);

  // Both sets, because a grant this session minted and a file this session holds are not the same
  // thing: accept.ts propagates onto `knowledgeIds`, which can name files uploaded elsewhere, while
  // `sessionId` names files uploaded here that may never have been attached as knowledge.
  const grantedFiles = [...fabFiles, ...(await db.fabFiles.findAllByIds(session.knowledgeIds ?? []))].filter(
    (file, index, all) => all.findIndex(other => other.id === file.id) === index
  );

  // Cascade BEFORE the tombstone. softDeletePlugin puts `deletedAt: null` on every findOne, and
  // findByIdAndUserId is a bare findOne, so a session tombstoned first is unreachable on a retry:
  // the guard above would throw and any grant this loop had not yet reached would stay live with
  // no surface left to clear it. Both live callers now wrap this in a transaction (the DELETE route
  // and the bulk route), so ordering is no longer the only defence - but it is the one that does not
  // depend on the caller remembering, and the service itself opens no transaction.
  const ownedFileIds = new Set(ownedFiles.map(file => file.id));

  for (const file of grantedFiles) {
    // A file this session owner is deleting below is going away regardless, and a guarded write on
    // it can raise ConcurrencyConflictError and abort the whole delete for nothing. Note the write
    // below is `deleteManyInIds`, which is softDeletePlugin's TOMBSTONE path, not a hard delete
    // (compare hardDeleteByIds, which passes `{ hardDelete: true }`) - so the skipped rows survive
    // on the tombstoned document. No read path exposes them: every FabFile aggregate filters
    // `deletedAt` and none projects `users`, findAccessibleById is a tombstone-filtered findOne, and
    // the one includeDeleted read that returns `users[]` is admin-only.
    if (ownedFileIds.has(file.id)) continue;
    // Only rows this session minted, and every grantee's, not just the deleter's: the session is
    // the source of those grants and it is going away, so leaving a sharee's behind strands it with
    // no surface left to revoke it. Keying on the tag rather than on an untagged row is what stops
    // this destroying a direct share of the same file to the same user, which is a separate row and
    // nothing to do with this session. Same qualification as sharingService/revoke.ts's cascade.
    const remaining = file.users.filter(user => user.sessionId !== session.id);
    if (remaining.length === file.users.length) continue;
    file.users = remaining;
    // Whole-doc grant write on a revocation path, so it takes the version guard for the same
    // reason sharingService/revoke.ts does: a racing guarded write must conflict, not clobber.
    await db.fabFiles.updateGuarded!(file);
  }

  session.deletedAt = new Date();

  await db.sessions.update(session);
  await db.projects.removeSession(session.id);

  await db.fabFiles.deleteManyInIds(ownedFiles.map(f => f.id));

  // Same helper deleteDataLake debits through. `ownedFiles` is single-owner by the filter above,
  // so the grouping collapses to one write today.
  await bestEffortAdjustOwnerStorage(db.users, groupStorageDeltaByOwner(ownedFiles, -1), logger);

  // Otherwise an enabled row lingers forever: the proactive-messaging worker's own
  // session.deletedAt guard stops it firing, but the cron's eligibility scan only skips a
  // stale row on session-not-found/deleted, it never deletes it (see getEligibleConfigs.ts).
  // Optional so a caller on the pre-cleanup adapter shape still compiles and runs.
  await db.sessionAgentConfigs?.deleteBySessionId(session.id);

  const mostRecent = await db.sessions.findRecentlyUpdatedByUserId(userId);

  return mostRecent;
};
