import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserRepository,
  IUserShare,
  Permission,
  ShareableAccessShape,
  heldPermissions,
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

  // Matches the TARGET user's entries and nobody else's. The project-scoped arm used
  // `userId !== target && projectId !== scope`, which also deleted every co-member's
  // project-derived grant, so one member leaving stripped the whole project's access.
  // Scoped, it matches on the (userId, projectId) pair pushShareable keys entries by: dropping
  // only the grant this project materialized, leaving a direct share or another project's intact.
  const isRevoked = (user: IUserShare) =>
    user.userId.toString() === userIdToRevoke && (type === 'projects' || !projectId || user.projectId === projectId);

  // Scope-aware, so a scoped revoke that matches no entry says so instead of removing nothing and
  // returning the document as if it had succeeded. Worth being honest about the reach: the only
  // caller that passes a projectId today is revokeFromProject's cascade below, which swallows
  // NotFoundError by design, and the HTTP route never sends one - so this currently guards a
  // future scoped caller rather than surfacing an error anyone sees now. Entries written before
  // pushShareable keyed on the pair carry only the last project's tag, so a scoped revoke against
  // an earlier project can land here; revoking without a projectId still clears every entry.
  if (!document.users.some(isRevoked)) throw new NotFoundError(`User not found in document`);

  document.users = document.users.filter(user => !isRevoked(user));

  if (type === 'projects') {
    await revokeFromProject({ project: document as IProjectDocument, userIdToRevoke }, adapters);
  } else if (!projectId && type === 'sessions') {
    // accept.ts's Session arm also pushes a plain (non-project) grant onto every file in
    // session.knowledgeIds; mirror that here so revoking the session doesn't leave those file
    // grants live. A projectId-tagged entry is independently governed by that project, so it is
    // left alone here exactly as the scoped branch leaves other grants alone.
    await revokeSessionKnowledgeFileGrants({ session: document as ISessionDocument, userIdToRevoke }, adapters);
  }

  // This filters `document.users` in memory and writes the whole doc back - a lost-update-sensitive
  // grant path, so it opts in to the version guard (`updateGuarded`). Because the doc carries `__v`, a
  // racing whole-doc write that ALSO goes through `updateGuarded` throws ConcurrencyConflictError (409,
  // surfaced by the shared errorHandler) instead of clobbering this revoke, and the route's
  // `withTransaction` rolls back the `revokeFromProject` side effects above on that conflict. Note the
  // guard only defends against other *guarded* writers: a plain `update` of the same doc (e.g. some
  // accept.ts paths) is not conditioned on `__v` and can still resurrect access - guarding those is a
  // follow-up. (Access *widening* via updateDocumentSharing is a targeted `$set` of
  // isGlobalRead/isGlobalWrite with no `__v`, so it stays on the unguarded path.)
  // `updateGuarded` is optional on IBaseRepository (additive for external implementers), but every
  // in-repo repo is a concrete BaseRepository that provides it.
  await dbModel.updateGuarded!(document);

  return document;
};

const revokeSessionKnowledgeFileGrants = async (
  parameters: { session: ISessionDocument; userIdToRevoke: string },
  adapters: RevokeSharingAdapters
) => {
  const { session, userIdToRevoke } = parameters;
  const { db } = adapters;

  const files = await db.fabFiles.findAllByIds(session.knowledgeIds ?? []);
  // Groups matter: a session owner who reaches a file only through a group still had the share
  // authority that let acceptance materialize the grant, and an id alone would silently skip it.
  const sessionOwner = await db.users.findById(session.userId);
  for (const file of files) {
    // knowledgeIds is client-writable with only shape validation (sessionService/update.ts), and
    // this function is authorized against the SESSION, not each file. Without a check here anyone
    // could point their own session at a stranger's file and strip a third party's grant on it.
    //
    // The predicate mirrors accept.ts's propagation gate, which materializes a file grant whenever
    // the inviter can SHARE the file, not only when they own it. Gating revocation on ownership
    // alone left a grant on a shared-but-not-owned file permanently un-revokable through the
    // session path. `heldPermissions` returns everything for the owner, so ownership still passes.
    const ownerCanShare =
      !!sessionOwner &&
      heldPermissions(file as ShareableAccessShape, sessionOwner.id, sessionOwner.groups ?? []).has(Permission.share);
    if (!ownerCanShare) continue;

    const remaining = file.users.filter(user => !(user.userId.toString() === userIdToRevoke && !user.projectId));
    if (remaining.length === file.users.length) continue;
    file.users = remaining;
    // Whole-doc grant write on the revocation path, same reason the main revoke below takes the
    // guard: a racing guarded write must conflict rather than silently resurrect this grant.
    await db.fabFiles.updateGuarded!(file);
  }
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
      // Every NotFoundError, not just the 'not in document' one: a member holding update/share
      // but not read is invisible to findAccessibleById's ['read','write'] predicate and lands on
      // a different message. This cascade is best-effort, so a row it cannot reach is a row with
      // nothing to revoke, never a reason to abort the whole revoke.
      if (!(e instanceof NotFoundError)) throw e;
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
      // Every NotFoundError, not just the 'not in document' one: a member holding update/share
      // but not read is invisible to findAccessibleById's ['read','write'] predicate and lands on
      // a different message. This cascade is best-effort, so a row it cannot reach is a row with
      // nothing to revoke, never a reason to abort the whole revoke.
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
};
