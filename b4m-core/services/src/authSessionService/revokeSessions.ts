import { Logger } from '@bike4mind/observability';
import { IAuthSessionDocument, IAuthSessionRepository } from '@bike4mind/common';

interface RevokeAdapters {
  db: { authSessions: Pick<IAuthSessionRepository, 'revokeBySid' | 'revokeAllByUserId' | 'findActiveByUserId'> };
  logger?: Logger;
}

/** Revoke a single session -- the per-device logout / "sign out this device" primitive. */
export const revokeSession = async (
  sid: string,
  { db, logger }: RevokeAdapters
): Promise<IAuthSessionDocument | null> => {
  const revoked = await db.authSessions.revokeBySid(sid);
  if (revoked) logger?.log('Revoked auth session', sid);
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
export const listUserSessions = async (userId: string, { db }: RevokeAdapters): Promise<IAuthSessionDocument[]> => {
  return db.authSessions.findActiveByUserId(userId);
};
