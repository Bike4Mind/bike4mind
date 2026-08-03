import { Logger } from '@bike4mind/observability';
import { IAuthSessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, UnauthorizedError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

interface RevokeSessionsAdapters {
  db: {
    users: Pick<IUserRepository, 'incrementTokenVersion'>;
    authSessions: Pick<IAuthSessionRepository, 'revokeAllByUserId'>;
  };
  logger?: Logger;
}

/**
 * Revoke ALL of a user's sessions (all devices): bump the tokenVersion kill switch AND revoke
 * every AuthSession row.
 *
 * Both are required. The tokenVersion bump invalidates outstanding access tokens on their next
 * request; revoking the sessions invalidates the opaque refresh tokens. Without the session
 * revoke, a live refresh token could rotate into a fresh access token stamped with the NEW
 * tokenVersion and defeat the revoke entirely. This stays all-or-nothing per user; per-device
 * logout is layered on top later (epic #1187). Returns the new tokenVersion.
 */
export const revokeUserSessions = async (userId: string, { db, logger }: RevokeSessionsAdapters): Promise<number> => {
  const newVersion = await db.users.incrementTokenVersion(userId);
  const revokedSessions = await db.authSessions.revokeAllByUserId(userId);
  logger?.log('Revoked all sessions for user', userId, 'tokenVersion:', newVersion, 'sessions:', revokedSessions);
  return newVersion;
};

const adminRevokeSessionsSchema = z.object({ id: z.string() });
export type AdminRevokeSessionsParameters = z.infer<typeof adminRevokeSessionsSchema>;

interface AdminRevokeSessionsAdapters {
  db: {
    users: Pick<IUserRepository, 'findById' | 'incrementTokenVersion'>;
    authSessions: Pick<IAuthSessionRepository, 'revokeAllByUserId'>;
  };
  logger?: Logger;
}

/**
 * Admin-initiated force-logout of another user. Mirrors adminDeleteUser's authz shape:
 * the caller's admin flag is checked in the service layer (not the route). Throws
 * UnauthorizedError for a non-admin caller and NotFoundError for an unknown target.
 */
export const adminRevokeUserSessions = async (
  adminId: string,
  parameters: AdminRevokeSessionsParameters,
  { db, logger }: AdminRevokeSessionsAdapters
): Promise<number> => {
  const { id } = secureParameters(parameters, adminRevokeSessionsSchema);

  const admin = await db.users.findById(adminId);
  if (!admin?.isAdmin) throw new UnauthorizedError('You are not authorized to revoke user sessions');

  const target = await db.users.findById(id);
  if (!target) throw new NotFoundError(`User ${id} not found`);

  return revokeUserSessions(id, { db, logger });
};
