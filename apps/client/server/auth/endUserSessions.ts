import type { Request } from 'express';
import {
  userRepository,
  authSessionRepository,
  realtimeConnectionRepository,
  trustedDeviceRepository,
  withTransaction,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { logAuthAudit } from '@server/utils/authAudit';

export type SessionEndReason = 'password_changed' | 'email_changed' | 'account_blocked';

export type SessionEnd = { userId: string; reason: SessionEndReason; actorUserId?: string };

/**
 * Commit a credential or account-state change and, when `sessionEndFor` asks for it, sign that user
 * out everywhere in the SAME transaction: revoke every session (tokenVersion bump) and drop every
 * trusted device. Trusted devices are not keyed on tokenVersion (see trustedDevice.ts), so a session
 * revoke alone would let a device keep skipping MFA. Mirrors the admin force-logout in
 * pages/api/users/[id]/revoke-sessions.ts.
 *
 * One transaction because a change that commits while its revoke fails is unrecoverable: the retry
 * is refused (same password, burned email token) or no longer looks like a change, so old sessions
 * would outlive it. Here a failed revoke rolls the change back and the request fails.
 *
 * `change` may be re-run on a transient transaction error (see withTransaction), so it must only
 * write through the database. The audit is written after commit and never fails the request.
 * The realtime-connection prune inside revokeUserSessions deliberately stays outside the transaction
 * (see outsideTransaction in realtimeConnectionRepository), so it cannot fail or roll back the change.
 */
export async function commitWithSessionEnd<T>(
  // any: express Request generics vary across call sites; only the logger and the request
  // metadata logAuthAudit reads are used.
  req: Request<any, any, any, any, any>,
  change: () => Promise<T>,
  sessionEndFor: (result: T) => SessionEnd | undefined
): Promise<T> {
  const { result, ended } = await withTransaction(async () => {
    const result = await change();
    const end = sessionEndFor(result);
    if (!end) return { result, ended: undefined };

    await userService.revokeUserSessions(end.userId, {
      db: {
        users: userRepository,
        authSessions: authSessionRepository,
        realtimeConnections: realtimeConnectionRepository,
      },
      logger: req.logger,
    });
    const revokedDevices = await trustedDeviceRepository.revokeAllForUser(end.userId);
    return { result, ended: { ...end, revokedDevices } };
  });

  if (ended) {
    const { userId, reason, actorUserId, revokedDevices } = ended;
    await logAuthAudit(req, { userId, event: 'session_revoked', actorUserId, metadata: { reason } });
    if (revokedDevices > 0) {
      await logAuthAudit(req, {
        userId,
        event: 'trusted_device_revoked',
        actorUserId,
        metadata: { revoked: revokedDevices, scope: 'all', reason },
      });
    }
  }
  return result;
}
