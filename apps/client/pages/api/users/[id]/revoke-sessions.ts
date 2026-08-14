import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository, authSessionRepository, trustedDeviceRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { logAuthAudit } from '@server/utils/authAudit';

/**
 * Admin action: force-logout a user by revoking all their sessions (tokenVersion bump).
 * Authz (admin-only) is enforced inside userService.adminRevokeUserSessions, matching
 * users/[id]/delete.ts. All-device by design; see revokeSessions.ts.
 */
const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const targetId = req.query.id!;
    const tokenVersion = await userService.adminRevokeUserSessions(
      req.user.id,
      { id: targetId },
      { db: { users: userRepository, authSessions: authSessionRepository }, logger: req.logger }
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
    return res.status(200).json({ message: 'Sessions revoked', userId: targetId, tokenVersion });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
