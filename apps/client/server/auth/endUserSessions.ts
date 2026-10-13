import type { Request } from 'express';
import { userRepository, authSessionRepository, trustedDeviceRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { logAuthAudit } from '@server/utils/authAudit';

export type SessionEndReason = 'password_changed' | 'email_changed' | 'account_blocked';

/**
 * Sign a user out everywhere after a credential or account-state change: revoke every session
 * (tokenVersion bump), drop every trusted device, and audit it. Trusted devices are not keyed on
 * tokenVersion (see trustedDevice.ts), so a session revoke alone would let a device keep skipping
 * MFA. Mirrors the admin force-logout in pages/api/users/[id]/revoke-sessions.ts.
 *
 * Returns the new tokenVersion. Throws if the session revoke fails: a credential change that
 * leaves old sessions alive must not report success.
 */
export async function endAllUserSessions(
  // any: express Request generics vary across call sites; only the logger and the request
  // metadata logAuthAudit reads are used.
  req: Request<any, any, any, any, any>,
  userId: string,
  { reason, actorUserId }: { reason: SessionEndReason; actorUserId?: string }
): Promise<number> {
  const tokenVersion = await userService.revokeUserSessions(userId, {
    db: { users: userRepository, authSessions: authSessionRepository },
    logger: req.logger,
  });
  const revokedDevices = await trustedDeviceRepository.revokeAllForUser(userId);

  await logAuthAudit(req, { userId, event: 'session_revoked', actorUserId, metadata: { reason } });
  if (revokedDevices > 0) {
    await logAuthAudit(req, {
      userId,
      event: 'trusted_device_revoked',
      actorUserId,
      metadata: { revoked: revokedDevices, scope: 'all', reason },
    });
  }
  return tokenVersion;
}
