import { Logger } from '@bike4mind/observability';
import { IUserRepository } from '@bike4mind/common';
import { NotFoundError, UnauthorizedError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

interface RevokeSessionsAdapters {
  db: {
    users: Pick<IUserRepository, 'incrementTokenVersion'>;
  };
  logger?: Logger;
}

/**
 * Revoke ALL of a user's sessions by bumping the server-side tokenVersion kill switch.
 * Every access/refresh token the user currently holds (any device) carries the old version
 * and is rejected on its next request. There is no per-device revocation: tokens carry no
 * session id, so this is all-or-nothing per user by design. Returns the new tokenVersion.
 */
export const revokeUserSessions = async (userId: string, { db, logger }: RevokeSessionsAdapters): Promise<number> => {
  const newVersion = await db.users.incrementTokenVersion(userId);
  logger?.log('Revoked all sessions for user', userId, 'new tokenVersion:', newVersion);
  return newVersion;
};

const adminRevokeSessionsSchema = z.object({ id: z.string() });
export type AdminRevokeSessionsParameters = z.infer<typeof adminRevokeSessionsSchema>;

interface AdminRevokeSessionsAdapters {
  db: {
    users: Pick<IUserRepository, 'findById' | 'incrementTokenVersion'>;
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
