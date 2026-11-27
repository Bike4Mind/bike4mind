import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserRepository,
  IUserShare,
  RepositoryUpdate,
} from '@bike4mind/common';
import { ForbiddenError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { grantWrite } from './grantWrite';
import type { SharedItem } from './projectGrantor';
import { canonicalId } from '../utils/objectIds';
import { createGrantLossCleanup, type GrantLossCleanup } from './grantLoss';

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
  /** Told which users may have lost access, so live subscriptions can be rebuilt after the commit. */
  onAccessRemoved?: (userIds: string[]) => void;
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
  // A row without read (e.g. share only) is invisible to the target's own lookup, so fall back to
  // the revoker's: the owner must be able to remove every row on their document.
  const asRevoker = async () => {
    const revoker = userId === userIdToRevoke ? null : await db.users.findById(userId);
    return revoker ? dbModel.shareable.findAccessibleById(revoker, id) : null;
  };
  const document = (await dbModel.shareable.findAccessibleById(member, id)) ?? (await asRevoker());
  if (!document) throw new NotFoundError(`${type} not found for ${id}`);

  // Authorization: only the document owner or the user themselves can revoke sharing
  const isOwner = (document as { userId?: string }).userId === userId;
  const isSelfRevoke = userId === userIdToRevoke;
  if (!isOwner && !isSelfRevoke) {
    throw new ForbiddenError('Only the document owner or the shared user themselves can revoke sharing');
  }

  // Matches the TARGET user's entries and nobody else's. The project-scoped arm used
  // `userId !== target && projectId !== scope`, which also deleted every co-member's
  // project-derived grant, so one member leaving stripped the whole project's access.
  // Scoped on a projectId, it matches the (userId, projectId) pair pushShareable keys entries by,
  // dropping only the grant that project materialized and leaving another project's intact.
  // UNSCOPED it is deliberately broader than pushShareable's key: with no projectId it matches
  // every row the user holds on this document - the direct share, each project's grant, and each
  // session's. That is the point of an unscoped revoke on a document you own, and it is why the
  // session tag is not part of this predicate: the cascades below filter on the tag, this does not.
  // The `type === 'projects'` disjunct makes a revoke ON a project unscoped-broad even when a
  // projectId is passed, which is not an exception to the above: rows on a project document are
  // never themselves projectId-tagged, so scoping one by projectId would match nothing.
  const isRevoked = (user: IUserShare) =>
    user.userId.toString() === userIdToRevoke && (type === 'projects' || !projectId || user.projectId === projectId);

  // Scope-aware, so a scoped revoke that matches no entry says so instead of removing nothing and
  // returning the document as if it had succeeded. Worth being honest about the reach: no
  // first-party caller passes a projectId except revokeFromProject's cascade below, which swallows
  // NotFoundError by design - but the HTTP route CAN send one. apps/client/pages/api/[type]/[id]/
  // revokeSharing.ts declares `projectId` optional and spreads the parsed body through, so a client
  // supplying a projectId that tags none of the target's rows gets a 404 here rather than the broad
  // revoke it probably meant. That is the fail-closed direction and it is why the scoped arm says so
  // instead of reporting a success that removed nothing. Entries written before pushShareable keyed
  // on the pair carry only the last project's tag, so a scoped revoke against an earlier project can
  // land here; revoking without a projectId still clears every entry.
  if (!document.users.some(isRevoked)) throw new NotFoundError(`User not found in document`);

  const removed = document.users.filter(isRevoked);
  document.users = document.users.filter(user => !isRevoked(user));
  const cleanup = createGrantLossCleanup(adapters);

  if (type === 'projects') {
    await revokeFromProject({ project: document as IProjectDocument, userIdToRevoke }, adapters, cleanup);
  } else {
    const item = cleanup.track(type, document as SharedItem, false);
    cleanup.enqueue(
      item,
      removed.map(row => String(row.userId))
    );
    if (!projectId && type === 'sessions') {
      const session = document as ISessionDocument;
      const files = [
        ...(await db.fabFiles.findAllByIds(session.knowledgeIds ?? [], { includeDeleted: true })),
        ...(await db.fabFiles.findSharingGrantFilesBySession(session.id, userIdToRevoke)),
      ];
      for (const file of files) {
        cleanup.removeRows(
          cleanup.track('files', file as SharedItem),
          row =>
            canonicalId(String(row.userId)) === canonicalId(userIdToRevoke) &&
            !!row.sessionId &&
            canonicalId(row.sessionId) === canonicalId(session.id)
        );
      }
    }
  }

  await cleanup.drain();
  await cleanup.flush();
  let write: Partial<typeof document> = grantWrite(document);
  if (type === 'projects') {
    const current = cleanup.trackProject(document as IProjectDocument, false).document;
    const project = document as IProjectDocument;
    project.fileIds = current.fileIds;
    project.sessionIds = current.sessionIds;
    project.systemPrompts = current.systemPrompts;
    write = {
      ...write,
      fileIds: current.fileIds,
      sessionIds: current.sessionIds,
      systemPrompts: current.systemPrompts,
    };
  }
  const guarded: { updateGuarded?: RepositoryUpdate<typeof document> } = dbModel;
  await guarded.updateGuarded!(write, { includeDeleted: true });
  adapters.onAccessRemoved?.([userIdToRevoke]);
  return document;
};

/**
 * Best-effort per-member cascade over a project's files and sessions.
 *
 * Returns the id lists with the target's own documents pruned instead of writing them back onto
 * `project`. Mutating the caller's document starved deleteProject's owner pass: it runs this once
 * per member and then once for the owner, and the owner's derived grants sit on exactly the
 * member-owned documents the member passes had already pruned from the list the owner pass reads.
 * Callers that want the pruning persisted assign it themselves.
 */
export const revokeFromProject = async (
  parameters: { project: IProjectDocument; userIdToRevoke: string },
  adapters: RevokeSharingAdapters,
  sharedCleanup?: GrantLossCleanup
): Promise<{ fileIds: string[]; sessionIds: string[]; systemPrompts: IProjectDocument['systemPrompts'] }> => {
  const { project, userIdToRevoke } = parameters;
  const { db } = adapters;
  const cleanup = sharedCleanup ?? createGrantLossCleanup(adapters);
  const current = cleanup.trackProject(
    {
      ...project,
      fileIds: [...project.fileIds],
      sessionIds: [...project.sessionIds],
      systemPrompts: [...(project.systemPrompts ?? [])],
    },
    false
  );
  const files = await db.fabFiles.findAllByIds(
    [...project.fileIds, ...(project.systemPrompts ?? []).map(prompt => prompt.fileId)],
    { includeDeleted: true }
  );
  const sessions = await db.sessions.findAllByIds(project.sessionIds, { includeDeleted: true });
  const isProjectRow = (row: IUserShare) => !!row.projectId && canonicalId(row.projectId) === canonicalId(project.id);
  const isTargetRow = (row: IUserShare) =>
    isProjectRow(row) && canonicalId(String(row.userId)) === canonicalId(userIdToRevoke);

  for (const file of files) {
    const item = cleanup.track('files', file as SharedItem);
    if (canonicalId(file.userId) === canonicalId(userIdToRevoke)) {
      await cleanup.removeReference(current, item);
    } else {
      cleanup.removeRows(item, isTargetRow);
    }
  }
  for (const session of sessions) {
    const item = cleanup.track('sessions', session as SharedItem);
    if (canonicalId(session.userId) === canonicalId(userIdToRevoke)) {
      await cleanup.removeReference(current, item);
      await cleanup.detachSessionKnowledge(item.document, current);
    } else {
      cleanup.removeRows(item, isTargetRow);
    }
  }
  if (!sharedCleanup) {
    await cleanup.drain();
    await cleanup.flush();
  }
  return {
    fileIds: current.document.fileIds,
    sessionIds: current.document.sessionIds,
    systemPrompts: current.document.systemPrompts,
  };
};
