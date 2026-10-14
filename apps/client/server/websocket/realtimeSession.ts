import { isAuthSessionActive } from '@bike4mind/common';
import { authSessionRepository } from '@bike4mind/database';
import { REALTIME_CONNECTION_MAX_LIFETIME_MS } from '@bike4mind/database/social';
import { UnauthorizedError } from '@server/utils/errors';

/** When a socket's credential is bounded by the gateway's own 2h cap rather than a token expiry:
 *  API-key sockets, and CLI JWT sockets (the CLI never reauths, so the token exp would cut them mid-stream). */
export const gatewayCapExpiry = (now = new Date()): Date =>
  new Date(now.getTime() + REALTIME_CONNECTION_MAX_LIFETIME_MS);

/**
 * Refuse a socket credential whose AuthSession is revoked or expired. The access token alone stays
 * valid for its TTL after a revoke, so $connect and reauth_connection check the session as well.
 * A sid-less (legacy) token has no session to check. The realtime sweep applies the same rule
 * (isAuthSessionActive, used by realtimeConnectionRepository.findSweepTargets).
 */
export async function assertRealtimeSessionActive(sid: string | undefined): Promise<void> {
  if (!sid) return;
  const session = await authSessionRepository.findBySid(sid);
  if (!isAuthSessionActive(session)) {
    throw new UnauthorizedError('Session expired');
  }
}
