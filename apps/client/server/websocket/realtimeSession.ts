import { authSessionRepository } from '@bike4mind/database';
import { REALTIME_CONNECTION_MAX_LIFETIME_MS } from '@bike4mind/database/social';
import { UnauthorizedError } from '@server/utils/errors';

/** API-key sockets carry no access-token expiry; they are bounded by the gateway's own cap. */
export const apiKeyConnectionExpiry = (now = new Date()): Date =>
  new Date(now.getTime() + REALTIME_CONNECTION_MAX_LIFETIME_MS);

/**
 * Refuse a socket credential whose AuthSession is revoked or expired. The access token alone stays
 * valid for its TTL after a revoke, so $connect and reauth_connection check the session as well.
 * A sid-less (legacy) token has no session to check. The realtime sweep applies the same rule
 * (realtimeConnectionRepository.findSweepTargets).
 */
export async function assertRealtimeSessionActive(sid: string | undefined): Promise<void> {
  if (!sid) return;
  const session = await authSessionRepository.findBySid(sid);
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw new UnauthorizedError('Session expired');
  }
}
