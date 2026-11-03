import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  userRepository,
  authSessionRepository,
  trustedDeviceRepository,
  realtimeConnectionRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { logAuthAudit } from '@server/utils/authAudit';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * Admin action: force-logout a user by revoking all their sessions (tokenVersion bump).
 * Authz (admin-only) is enforced inside userService.adminRevokeUserSessions, matching
 * users/[id]/delete.ts. All-device by design; see revokeSessions.ts. That check re-reads the
 * role from the database, so an API key's admin scope is enforced here instead.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const targetId = req.query.id!;
    // Optional for API-key callers that predate it; the admin profile always sends one.
    const rawReason = (req.body as { reason?: unknown } | undefined)?.reason;
    const reason = rawReason === undefined ? undefined : parseAdminActionReason(rawReason);
    const tokenVersion = await userService.adminRevokeUserSessions(
      req.user.id,
      { id: targetId },
      {
        db: {
          users: userRepository,
          authSessions: authSessionRepository,
          realtimeConnections: realtimeConnectionRepository,
        },
        logger: req.logger,
      }
    );
    // Trusted devices are deliberately NOT keyed on tokenVersion (see trustedDevice.ts), so a
    // session revoke does not drop them on its own. A force-logout is the compromised-account
    // response, and leaving a trust alive would let the attacker's device keep skipping MFA.
    const revokedDevices = await trustedDeviceRepository.revokeAllForUser(targetId);

    // Forensic trail for the admin force-logout (best-effort; never blocks the response).
    await logAuthAudit(req, {
      userId: targetId,
      event: 'session_revoked',
      actorUserId: req.user.id,
    });
    if (revokedDevices > 0) {
      await logAuthAudit(req, {
        userId: targetId,
        event: 'trusted_device_revoked',
        actorUserId: req.user.id,
        metadata: { revoked: revokedDevices, scope: 'all', reason: 'session_revoked' },
      });
    }
    // Read after the service's admin check. The revoke has already happened, so a failed read must not fail it.
    const target = await userRepository.findById(targetId).catch(() => null);
    // Mirrors the UserAuthAuditLog row into the admin audit log; best-effort, so it never fails the revoke.
    await recordAdminActionFromRequest(req, {
      action: 'user.sessions.revoked',
      target: {
        kind: 'user',
        id: targetId,
        displayName: target?.name || target?.username || target?.email || targetId,
      },
      summary: 'signed the user out of every session',
      reason,
      details: { tokenVersion, revokedDevices },
    });
    return res.status(200).json({ message: 'Sessions revoked', userId: targetId, tokenVersion });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
