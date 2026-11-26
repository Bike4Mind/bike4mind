import {
  heldPermissions,
  IFabFileRepository,
  IProjectDocument,
  IShareableDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserRepository,
  IUserShare,
  Permission,
  RepositoryUpdate,
} from '@bike4mind/common';
import { ForbiddenError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { grantWrite } from './grantWrite';

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

type SharedItem = IShareableDocument & { id: string; userId: string };

const projectParticipants = (project: Pick<IProjectDocument, 'userId' | 'users'>) => [
  project.userId,
  ...project.users.map(u => u.userId),
];

/**
 * Project grants on an item are passed on from whoever attached it. Once `userIdToRevoke` loses the
 * item, every project they take part in that holds it is left without a grantor unless the item's
 * owner takes part in that project or another participant still holds share on it outside the
 * project. Such projects lose the item and every row they minted on it. Mutates `document.users`;
 * returns the projects the item was detached from.
 */
const detachFromProjectsWithoutGrantor = async (
  parameters: {
    document: SharedItem;
    type: 'files' | 'sessions';
    member: NonNullable<Awaited<ReturnType<IUserRepository['findById']>>>;
    userIdToRevoke: string;
  },
  adapters: RevokeSharingAdapters
): Promise<IProjectDocument[]> => {
  const { document, type, member, userIdToRevoke } = parameters;
  const { db } = adapters;
  const projects = await db.projects.shareable.findAllAccessible(member);
  const detached: IProjectDocument[] = [];
  for (const project of projects) {
    const referenced =
      type === 'files'
        ? [...project.fileIds, ...(project.systemPrompts ?? []).map(prompt => prompt.fileId)]
        : project.sessionIds;
    if (!referenced.map(String).includes(document.id)) continue;
    const participants = projectParticipants(project).filter(id => id !== userIdToRevoke);
    if (participants.includes(document.userId)) continue;
    const outsideProject = { ...document, users: document.users.filter(u => u.projectId !== project.id) };
    // Group rows are not consulted: participants' groups are not loaded here, so this fails closed.
    if (participants.some(id => heldPermissions(outsideProject, id).has(Permission.share))) continue;

    if (type === 'files') {
      await db.projects.pullFileReferences([document.id], { projectId: project.id });
    } else {
      await db.projects.update({ id: project.id, sessionIds: project.sessionIds.filter(id => id !== document.id) });
    }
    document.users = outsideProject.users;
    detached.push(project);
  }
  return detached;
};

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
  const revoker = userId === userIdToRevoke ? null : await db.users.findById(userId);
  const document =
    (await dbModel.shareable.findAccessibleById(member, id)) ??
    (revoker ? await dbModel.shareable.findAccessibleById(revoker, id) : null);
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

  document.users = document.users.filter(user => !isRevoked(user));

  let write: Partial<typeof document> = grantWrite(document);
  if (type === 'projects') {
    const project = document as IProjectDocument;
    const pruned = await revokeFromProject({ project, userIdToRevoke }, adapters);
    project.fileIds = pruned.fileIds;
    project.sessionIds = pruned.sessionIds;
    project.systemPrompts = pruned.systemPrompts;
    write = {
      ...write,
      fileIds: pruned.fileIds,
      sessionIds: pruned.sessionIds,
      systemPrompts: pruned.systemPrompts,
    };
  } else if (!projectId) {
    const detachedFrom = await detachFromProjectsWithoutGrantor(
      { document: document as SharedItem, type, member, userIdToRevoke },
      adapters
    );
    if (detachedFrom.length > 0) write = grantWrite(document);
    adapters.onAccessRemoved?.(detachedFrom.flatMap(projectParticipants));
  }
  adapters.onAccessRemoved?.([userIdToRevoke]);

  if (!projectId && type === 'sessions') {
    // accept.ts's Session arm also pushes a plain (non-project) grant onto every file in
    // session.knowledgeIds; mirror that here so revoking the session doesn't leave those file
    // grants live. A projectId-tagged entry is independently governed by that project, so it is
    // left alone here exactly as the scoped branch leaves other grants alone.
    await revokeSessionKnowledgeFileGrants({ session: document as ISessionDocument, userIdToRevoke }, adapters);
  }

  // This filters `document.users` in memory and writes it back (see grantWrite) - a lost-update-sensitive
  // grant path, so it opts in to the version guard (`updateGuarded`). Because the write carries `__v`, a
  // racing write that ALSO goes through `updateGuarded` throws ConcurrencyConflictError (409,
  // surfaced by the shared errorHandler) instead of clobbering this revoke, and the route's
  // `withTransaction` rolls back the `revokeFromProject` side effects above on that conflict. Grants
  // and removals through `shareable.updateUserShares` bump `__v` when they change `users`, so they
  // also make this write conflict rather than be overwritten. (Access *widening* via updateDocumentSharing is a targeted `$set` of
  // isGlobalRead/isGlobalWrite with no `__v`, so it stays on the unguarded path.)
  // `updateGuarded` is optional on IBaseRepository (additive for external implementers), but every
  // in-repo repo is a concrete BaseRepository that provides it.
  // Typed as one repository: a union of the three repos' overloaded `updateGuarded`s is not callable.
  const guarded: { updateGuarded?: RepositoryUpdate<typeof document> } = dbModel;
  await guarded.updateGuarded!(write, { includeDeleted: true });

  return document;
};

const revokeSessionKnowledgeFileGrants = async (
  parameters: { session: ISessionDocument; userIdToRevoke: string },
  adapters: RevokeSharingAdapters
) => {
  const { session, userIdToRevoke } = parameters;
  const { db } = adapters;

  // knowledgeIds as of now misses a file detached before this revoke, so rows are also found by tag.
  const files = uniqueById([
    ...(await db.fabFiles.findAllByIds(session.knowledgeIds ?? [])),
    ...(await db.fabFiles.find({ users: { $elemMatch: { userId: userIdToRevoke, sessionId: session.id } } })),
  ]);
  for (const file of files) {
    // Only rows this session minted. The tag is the authorization: a row carrying `sessionId` was
    // written by accept.ts's propagation, which already required the inviter to hold share on the
    // file, so matching on it cannot reach a grant this session did not create. knowledgeIds is
    // client-writable (update.ts checks only additions; removals, legacy rows and notebook import
    // are not gated), and that is exactly why the filter keys on the tag rather than on the session
    // owner's present authority - pointing your session at a stranger's file gives you nothing,
    // because no row on it carries your session id.
    //
    // Untagged rows are left alone: a direct share of the same file to the same user is a separate
    // row, and deleting it here destroyed a grant a third party had made and the revoker had no say
    // over. Tagging also retires the old owner-holds-share gate, which read the session owner while
    // the mint read the inviter - not the same principal whenever a sharee minted the invite, so a
    // grant could be stranded un-revokable through the very path that created it.
    const remaining = file.users.filter(
      user => !(user.userId.toString() === userIdToRevoke && user.sessionId === session.id)
    );
    if (remaining.length === file.users.length) continue;
    file.users = remaining;
    // Grant write on the revocation path, same reason the main revoke above takes the guard: a
    // racing guarded write must conflict rather than silently resurrect this grant.
    await db.fabFiles.updateGuarded!(grantWrite(file), { includeDeleted: true });
  }
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
  adapters: RevokeSharingAdapters
): Promise<{ fileIds: string[]; sessionIds: string[]; systemPrompts: IProjectDocument['systemPrompts'] }> => {
  const { project, userIdToRevoke } = parameters;
  const { db } = adapters;

  const files = uniqueById(
    await db.fabFiles.findAllByIds([...project.fileIds, ...(project.systemPrompts ?? []).map(prompt => prompt.fileId)])
  );
  const sessions = await db.sessions.findAllByIds(project.sessionIds);

  let fileIds = project.fileIds;
  let sessionIds = project.sessionIds;
  let systemPrompts = project.systemPrompts ?? [];

  // Everyone else holding a grant this project minted on the leaver's documents. The owner is never in
  // project.users, but addFiles/addSessions grant the owner every document a member contributes.
  const othersInProject = Array.from(
    new Set([project.userId, ...project.users.map(u => u.userId)].filter(id => id !== userIdToRevoke))
  );
  // One row the cascade cannot reach must not keep the others: same NotFoundError tolerance as below.
  const revokeFromOthers = async (id: string, type: 'files' | 'sessions') => {
    for (const userId of othersInProject) {
      try {
        await revoke(userIdToRevoke, { id, type, userId, projectId: project.id }, adapters);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
  };

  for (const file of files) {
    try {
      // The leaver's own file leaves the project, so everyone else loses this project's grant on it.
      if (file.userId === userIdToRevoke) {
        await revokeFromOthers(file.id, 'files');

        fileIds = fileIds.filter(id => id !== file.id);
        systemPrompts = systemPrompts.filter(prompt => prompt.fileId !== file.id);
      } else {
        await revoke(
          file.userId,
          { id: file.id, type: 'files', userId: userIdToRevoke, projectId: project.id },
          adapters
        );
      }
    } catch (e) {
      // Best-effort: a row it cannot reach is a row with nothing to revoke, never a reason to abort.
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  for (const session of sessions) {
    try {
      // The leaver's own session leaves the project, so everyone else loses this project's grant on it.
      if (session.userId === userIdToRevoke) {
        await revokeFromOthers(session.id, 'sessions');

        sessionIds = sessionIds.filter(id => id !== session.id);
      } else {
        await revoke(
          session.userId,
          { id: session.id, type: 'sessions', userId: userIdToRevoke, projectId: project.id },
          adapters
        );
      }
    } catch (e) {
      // Best-effort: a row it cannot reach is a row with nothing to revoke, never a reason to abort.
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  return { fileIds, sessionIds, systemPrompts };
};

const uniqueById = <T extends { id: string }>(docs: T[]): T[] =>
  docs.filter((doc, index) => docs.findIndex(other => other.id === doc.id) === index);
