import type { Logger } from '@bike4mind/observability';
import { authSessionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { assertAccountStateUsable } from './assertAccountStateUsable';

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
    await authSessionService.revokeSession(rotated.sid, { db: { authSessions: authSessionRepository }, logger });
    throw error;
  }
}
