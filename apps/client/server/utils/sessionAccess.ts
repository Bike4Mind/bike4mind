/**
 * Session Access Verification Utility
 *
 * Shared object-level authorization for routes that act on a caller-supplied
 * session id (or a quest id, which is bound to a session). Mirrors the
 * questMasterPlanAccess.ts convention: throw typed HTTPError subclasses that
 * baseApi's errorHandler maps to a status code.
 *
 * canAccessSession mirrors the arms the shareable-document mixin and CASL already apply to
 * sessions (findAccessibleById / findUpdateAccessById plus the isGlobalRead/isGlobalWrite flags
 * updateSharing.ts writes and ability.ts honors), so it does not over-deny a globally-shared
 * session on these routes.
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
import { Types } from 'mongoose';

/** Read routes accept a read-or-write grant; write routes require an update-level grant. */
export type SessionAccessLevel = 'read' | 'write';

function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

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
  session: Pick<ISessionDocument, 'userId' | 'users' | 'isGlobalRead' | 'isGlobalWrite'>,
  userId: string,
  level: SessionAccessLevel = 'read',
  userGroups: readonly string[] = []
): boolean {
  if (level === 'write') {
    return canUpdateShareable(session, userId, userGroups) || !!session.isGlobalWrite;
  }
  if (session.userId === userId) return true;
  if (session.isGlobalRead || session.isGlobalWrite) return true;
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
 * Filter a batch of quests to those the caller may read, resolving each quest's
 * session and applying the owner+shares predicate. A quest whose session is
 * missing or not accessible is DROPPED (not thrown), so a doctored questId in an
 * otherwise-owned export silently excludes the foreign quest instead of failing
 * the whole export. Distinct sessions are loaded once.
 */
export async function filterReadableQuests<T extends { sessionId?: string }>(
  quests: T[],
  userId: string
): Promise<T[]> {
  const sessionIds = [...new Set(quests.map(q => q.sessionId).filter((s): s is string => !!s))];
  const readable = new Set<string>();
  await Promise.all(
    sessionIds.map(async id => {
      const session = isValidObjectId(id) ? await sessionRepository.findById(id) : null;
      if (session && canAccessSession(session, userId)) {
        readable.add(id);
      }
    })
  );
  return quests.filter(q => !!q.sessionId && readable.has(q.sessionId));
}
