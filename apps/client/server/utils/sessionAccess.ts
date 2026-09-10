/**
 * Session Access Verification Utility
 *
 * Shared object-level authorization for routes that act on a caller-supplied
 * session id (or a quest id, which is bound to a session). Mirrors the
 * questMasterPlanAccess.ts convention: throw typed HTTPError subclasses that
 * baseApi's errorHandler maps to a status code.
 *
 * canAccessSession's write arm delegates to canUpdateShareable (the same predicate the chat path
 * uses); its read arm matches the deployed CASL ability (ability.ts grants read on isGlobalRead /
 * isGlobalWrite), NOT the shareable mixin's findAccessibleById - that method carries a groups arm
 * and no isGlobalRead arm, the opposite of the read arm here. See the read-arm note below.
 *
 * Security: a missing session and a forbidden session both surface as
 * NotFoundError so a caller cannot probe which session ids exist.
 */

import { sessionRepository } from '@bike4mind/database';
import {
  ISessionDocument,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  canUpdateShareable,
} from '@bike4mind/common';
import { isValidObjectId, toObjectIdString } from '@server/utils/objectId';

/** Read routes accept a read-or-write grant; write routes require an update-level grant. */
export type SessionAccessLevel = 'read' | 'write';

/**
 * May `userId` access `session` at the requested level?
 * - read:  owner, any direct user-share, isGlobalRead, or isGlobalWrite
 * - write: the house update predicate (`canUpdateShareable`: owner, or a user/group share carrying
 *          `update`), with isGlobalWrite layered on top.
 *
 * The write arm delegates to `canUpdateShareable` so it cannot drift from the same predicate the
 * chat path uses (ChatCompletionInvoke.ts, sessions/[id]/chat/[messageId]); `isGlobalWrite` is the
 * one documented session-only extension on top of it. `userGroups` are the caller's group ids
 * (session group-shares are latent today - nothing writes them - so it defaults to none).
 */
export function canAccessSession(
  session: Pick<ISessionDocument, 'userId' | 'users' | 'groups' | 'isGlobalRead' | 'isGlobalWrite'>,
  userId: string,
  level: SessionAccessLevel = 'read',
  userGroups: readonly string[] = []
): boolean {
  if (level === 'write') {
    return canUpdateShareable(session, userId, userGroups) || !!session.isGlobalWrite;
  }
  if (session.userId === userId) return true;
  if (session.isGlobalRead || session.isGlobalWrite) return true;
  // The read arm has no group-share arm (the write arm does, via canUpdateShareable). A session
  // group-shared with `update` would pass write yet 404 on read - a latent inversion, unreachable
  // today because nothing writes session group-shares (pushShareable touches users[] only). Add a
  // group arm here if session group-shares ever ship.
  return session.users?.some(u => u.userId === userId) ?? false;
}

/**
 * Verify the caller may access a session at the requested level before any read/write on a
 * caller-supplied session id. Returns the session document on success.
 *
 * @throws UnauthorizedError when userId is missing
 * @throws BadRequestError when sessionId is not a valid ObjectId
 * @throws NotFoundError when the session is missing OR not accessible
 */
export async function assertSessionAccess(
  sessionId: string | undefined,
  userId: string | undefined,
  level: SessionAccessLevel = 'read',
  userGroups: readonly string[] = []
): Promise<ISessionDocument> {
  if (!userId) {
    throw new UnauthorizedError('Unauthorized');
  }
  if (!sessionId || !isValidObjectId(sessionId)) {
    throw new BadRequestError('Invalid session ID');
  }

  const session = await sessionRepository.findById(sessionId);
  if (!session || !canAccessSession(session, userId, level, userGroups)) {
    throw new NotFoundError('Session not found');
  }

  return session;
}

/**
 * Filter a batch of quests to those an export may legitimately include, resolving each quest's
 * session and applying an owner-OR-caller predicate. A quest is kept when EITHER the plan owner or
 * the caller can read its session: the owner's readability is what marks the quest as a genuine
 * part of the plan (a doctored questId the owner never linked is readable by neither and dropped),
 * while the caller arm covers a sharee's own contributions. Sessions are resolved with
 * includeDeleted so an owner exporting a plan that references a session they soft-deleted still
 * gets their own content back. A quest whose session is missing, or accessible to neither, is
 * DROPPED (not thrown) so the caller can count and surface it. Distinct sessions are loaded once.
 */
export async function filterReadableQuests<T extends { sessionId?: string }>(
  quests: T[],
  userId: string,
  ownerId?: string
): Promise<T[]> {
  const sessionIds = [...new Set(quests.map(q => q.sessionId).filter((s): s is string => !!s && isValidObjectId(s)))];
  const sessions =
    sessionIds.length > 0 ? await sessionRepository.findAllByIds(sessionIds, { includeDeleted: true }) : [];
  const readable = new Set<string>();
  for (const session of sessions) {
    if (canAccessSession(session, userId) || (!!ownerId && canAccessSession(session, ownerId))) {
      readable.add(session.id);
    }
  }
  return quests.filter(q => {
    const normalized = q.sessionId ? toObjectIdString(q.sessionId) : undefined;
    return !!normalized && readable.has(normalized);
  });
}
