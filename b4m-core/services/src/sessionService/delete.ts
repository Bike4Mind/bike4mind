import {
  chargedBytes,
  IFabFileRepository,
  IProjectRepository,
  ISessionRepository,
  ISessionAgentConfigRepository,
  IOrganizationRepository,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { bestEffortAdjustOwnerStorage, groupStorageDeltaByOwner } from '../dataLakeService/ports';
import { createGrantLossCleanup, requireGrantorUsers } from '../sharingService/grantLoss';
import type { GrantorUsers, SharedItem } from '../sharingService/projectGrantor';
import { canonicalId } from '../utils/objectIds';

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
    users?: Pick<IUserRepository, 'incrementCurrentStorage'> & Partial<GrantorUsers>;
    // Required: it arrived with owner billing, so no caller predates it, and an org-owned file left
    // undebited would hold the whole org's quota.
    organizations: Pick<IOrganizationRepository, 'incrementCurrentStorage'>;
    // Optional: this is a published, patch-released signature (re-exported from
    // @bike4mind/services), so an existing caller built against the pre-cleanup shape must keep
    // compiling and running without it - the cleanup below is then just skipped for that caller.
    sessionAgentConfigs?: ISessionAgentConfigRepository;
  };
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
  onAccessRemoved?: (userIds: string[]) => void;
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
  // Tool-generated files link to their notebook through provenance, not `sessionId` (see
  // persistGeneratedFileAsFabFile). They are the user's library and outlive the notebook (deleted
  // from Files instead), so they are not in the delete set, but they still lose this session's grants.
  const sessionFiles = await db.fabFiles.find({ sessionId: session.id });
  const generatedFiles = await db.fabFiles.findToolGeneratedBySessionId(session.id);
  const ownedFiles = sessionFiles.filter(file => file.userId === userId);

  // Both sets, because a grant this session minted and a file this session holds are not the same
  // thing: accept.ts propagates onto `knowledgeIds`, which can name files uploaded elsewhere, while
  // `sessionId` names files uploaded here that may never have been attached as knowledge.
  const grantedFiles = [
    ...sessionFiles,
    ...generatedFiles,
    ...(await db.fabFiles.findAllByIds(session.knowledgeIds ?? [], { includeDeleted: true })),
    // Files detached from the notebook still carry the rows it minted.
    ...(await db.fabFiles.findSharingGrantFilesBySession(session.id)),
  ].filter((file, index, all) => all.findIndex(other => other.id === file.id) === index);

  // Cascade BEFORE the tombstone. softDeletePlugin puts `deletedAt: null` on every findOne, and
  // findByIdAndUserId is a bare findOne, so a session tombstoned first is unreachable on a retry:
  // the guard above would throw and any grant this loop had not yet reached would stay live with
  // no surface left to clear it. Both live callers now wrap this in a transaction (the DELETE route
  // and the bulk route), so ordering is no longer the only defence - but it is the one that does not
  // depend on the caller remembering, and the service itself opens no transaction.
  const ownedFileIds = new Set(ownedFiles.map(file => file.id));

  const changing = grantedFiles.filter(
    file =>
      !ownedFileIds.has(file.id) &&
      file.users.some(row => !!row.sessionId && canonicalId(row.sessionId) === canonicalId(session.id))
  );
  const groupIds = (session.groups ?? [])
    .filter(group => group.permissions?.some(permission => ['read', 'write'].includes(permission)))
    .map(group => group.groupId);
  const referencingProjects = session.knowledgeIds?.length ? await db.projects.findAllBySessionId(session.id) : [];
  const needsGroupActors = !!adapters.onAccessRemoved && groupIds.length > 0;
  const needsCleanup = changing.length > 0 || referencingProjects.length > 0;
  const grantorUsers = needsCleanup || needsGroupActors ? requireGrantorUsers(db.users) : undefined;
  const groupActors =
    needsGroupActors && grantorUsers ? Object.values(await grantorUsers.findUserIdsByGroupIds(groupIds)).flat() : [];
  if (needsCleanup && grantorUsers) {
    const cleanup = createGrantLossCleanup({
      db: { projects: db.projects, fabFiles: db.fabFiles, sessions: db.sessions, users: grantorUsers },
      onAccessRemoved: adapters.onAccessRemoved,
    });
    for (const file of changing) {
      cleanup.removeRows(
        cleanup.track('files', file as SharedItem),
        row => !!row.sessionId && canonicalId(row.sessionId) === canonicalId(session.id)
      );
    }
    await cleanup.detachDeletedSession(session as SharedItem, referencingProjects);
    await cleanup.drain();
    await cleanup.flush();
  }

  session.deletedAt = new Date();

  await db.sessions.update({ id: session.id, deletedAt: session.deletedAt });
  await db.projects.removeSession(session.id);
  adapters.onAccessRemoved?.([...new Set([userId, ...session.users.map(row => String(row.userId)), ...groupActors])]);

  await db.fabFiles.deleteManyInIds(ownedFiles.map(f => f.id));

  // Same helper deleteDataLake debits through. One uploader's files can split across a personal owner and org owners, so this may be several writes.
  await bestEffortAdjustOwnerStorage(
    db,
    groupStorageDeltaByOwner(
      ownedFiles.map(f => ({ userId: f.userId, organizationId: f.organizationId, fileSize: chargedBytes(f) })),
      -1
    ),
    logger
  );

  // Otherwise an enabled row lingers forever: the proactive-messaging worker's own
  // session.deletedAt guard stops it firing, but the cron's eligibility scan only skips a
  // stale row on session-not-found/deleted, it never deletes it (see getEligibleConfigs.ts).
  // Optional so a caller on the pre-cleanup adapter shape still compiles and runs.
  await db.sessionAgentConfigs?.deleteBySessionId(session.id);

  const mostRecent = await db.sessions.findRecentlyUpdatedByUserId(userId);

  return mostRecent;
};
