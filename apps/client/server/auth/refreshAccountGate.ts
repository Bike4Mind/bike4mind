import type { Logger } from '@bike4mind/observability';
import { authSessionRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { assertAccountStateUsable } from '@bike4mind/server-utils/auth/assertAccountStateUsable';

type AccountStateUser = Parameters<typeof assertAccountStateUsable>[0];

/**
 * Refresh-time account-state gate, shared by both refresh endpoints (pages/api/auth/refreshToken.ts
 * and pages/api/oauth/refresh.ts) so a blocked account cannot keep trading its refresh token for
 * access tokens. Mirrors the per-request gate in verifyJwtPayload.
 *
 * rotateSession has already advanced the session by the time the user is known, so a refused
 * account's session is revoked here. Left alone, the row would keep a secret the client never
 * received, and once the block lifts every refresh would hit the recovery cap (429) instead of
 * ending cleanly at sign-in.
 */
export async function refuseBlockedRotatedSession(
  rotated: { sid: string; user: AccountStateUser },
  logger?: Logger
): Promise<void> {
  try {
    assertAccountStateUsable(rotated.user);
  } catch (error) {
    try {
      await authSessionService.revokeSession(rotated.sid, {
        db: { authSessions: authSessionRepository, realtimeConnections: realtimeConnectionRepository },
        logger,
      });
    } catch (revokeError) {
      // Keep the refusal: it carries the reason the client needs to see. A failed revoke leaves
      // only a session the client never received, so it must not replace the typed refusal.
      logger?.error('Failed to revoke a refused session', revokeError);
    }
    throw error;
  }
}
