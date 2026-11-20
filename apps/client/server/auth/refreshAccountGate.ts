import type { Logger } from '@bike4mind/observability';
import { accountSuspendedError, type HTTPError } from '@bike4mind/common';
import { User, authSessionRepository, realtimeConnectionRepository } from '@bike4mind/database';
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

/**
 * Suspending signs the user out everywhere, so their next refresh fails as a plain invalid token and
 * the app would read it as an expired session. When the presented token is still a secret of its
 * session (current or one generation back, so it proves the caller held that session) and the owner is
 * now suspended, this is the typed `account_suspended` refusal to send instead; null otherwise, and the
 * caller keeps its original 401. Read-only: the session is already revoked.
 */
export async function suspendedSessionRefusal(opaqueToken: string): Promise<HTTPError | null> {
  const parsed = authSessionService.parseRefreshToken(opaqueToken);
  if (!parsed) return null;
  const session = await authSessionRepository.findBySid(parsed.sid);
  if (!session) return null;
  const presentedHash = authSessionService.hashRefreshSecret(parsed.secret);
  if (presentedHash !== session.refreshTokenHash && presentedHash !== session.previousRefreshTokenHash) return null;
  const owner = (await User.findById(session.userId).select('isBanned suspensionReasonCategory').lean()) as {
    isBanned?: boolean;
    suspensionReasonCategory?: string | null;
  } | null;
  return owner?.isBanned ? accountSuspendedError(owner.suspensionReasonCategory) : null;
}
