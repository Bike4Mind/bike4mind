import { Logger } from '@bike4mind/observability';
import { IAuthSessionDocument, IAuthSessionRepository, IRealtimeConnectionRepository } from '@bike4mind/common';
import { endRealtimeConnections } from './endRealtimeConnections';

interface RevokeAdapters {
  db: {
    authSessions: Pick<IAuthSessionRepository, 'revokeBySid' | 'revokeAllByUserId'>;
    realtimeConnections: Pick<IRealtimeConnectionRepository, 'endConnections'>;
  };
  logger?: Logger;
}

interface ListAdapters {
  db: { authSessions: Pick<IAuthSessionRepository, 'findActiveByUserId'> };
}

/** Revoke a single session -- the per-device logout / "sign out this device" primitive. Also ends
 *  that session's realtime connections (even when the row was already revoked). */
export const revokeSession = async (
  sid: string,
  { db, logger }: RevokeAdapters
): Promise<IAuthSessionDocument | null> => {
  const revoked = await db.authSessions.revokeBySid(sid);
  if (revoked) logger?.log('Revoked auth session', sid);
  await endRealtimeConnections({ sid }, { db, logger });
  return revoked;
};

/**
 * Revoke every active session for a user ("log out all devices"). `exceptSid` keeps one session
 * alive -- e.g. "log out my other devices" from the current one. Returns the count revoked.
 */
export const revokeAllUserSessions = async (
  userId: string,
  options: { exceptSid?: string },
  { db, logger }: RevokeAdapters
): Promise<number> => {
  const count = await db.authSessions.revokeAllByUserId(userId, options);
  await endRealtimeConnections(
    { userId, ...(options.exceptSid && { exceptSid: options.exceptSid }), sessionsOnly: true },
    { db, logger }
  );
  logger?.log(
    'Revoked',
    count,
    'auth session(s) for user',
    userId,
    options.exceptSid ? `(except ${options.exceptSid})` : ''
  );
  return count;
};

/** List a user's active sessions, newest-used first. Backs the active-sessions management UI. */
export const listUserSessions = async (userId: string, { db }: ListAdapters): Promise<IAuthSessionDocument[]> => {
  return db.authSessions.findActiveByUserId(userId);
};
