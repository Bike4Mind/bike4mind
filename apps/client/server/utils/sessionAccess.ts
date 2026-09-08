/**
 * Session Access Verification Utility
 *
 * Shared object-level authorization for routes that act on a caller-supplied
 * session id (or a quest id, which is bound to a session). Mirrors the
 * questMasterPlanAccess.ts convention: throw typed HTTPError subclasses that
 * baseApi's errorHandler maps to a status code.
 *
 * Owner+shares predicate kept in sync with the inline check at
 * sessions/[id]/chat/[messageId]/index.ts:
 *   session.userId === userId || session.users?.some(u => u.userId === userId)
 *
 * Security: a missing session and a forbidden session both surface as
 * NotFoundError so a caller cannot probe which session ids exist.
 */

import { sessionRepository } from '@bike4mind/database';
import { ISessionDocument, BadRequestError, NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { Types } from 'mongoose';

function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

/** Owner or any direct user-share may access a session. */
export function canAccessSession(session: Pick<ISessionDocument, 'userId' | 'users'>, userId: string): boolean {
  return session.userId === userId || (session.users?.some(u => u.userId === userId) ?? false);
}

/**
 * Verify the caller owns or shares a session before any read/write on a
 * caller-supplied session id. Returns the session document on success.
 *
 * @throws UnauthorizedError when userId is missing
 * @throws BadRequestError when sessionId is not a valid ObjectId
 * @throws NotFoundError when the session is missing OR not accessible
 */
export async function assertSessionAccess(
  sessionId: string | undefined,
  userId: string | undefined
): Promise<ISessionDocument> {
  if (!userId) {
    throw new UnauthorizedError('Unauthorized');
  }
  if (!sessionId || !isValidObjectId(sessionId)) {
    throw new BadRequestError('Invalid session ID');
  }

  const session = await sessionRepository.findById(sessionId);
  if (!session || !canAccessSession(session, userId)) {
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
