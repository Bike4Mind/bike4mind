import { hasAdminPermission } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import {
  userRepository,
  trustedDeviceRepository,
  passkeyCredentialRepository,
  withTransaction,
} from '@bike4mind/database';
import { redactUserSecretsForSelf, selfUserResponseSchema } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { logAuthAudit } from '@server/utils/authAudit';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';
import * as z from 'zod';

const forceResetBodySchema = z.object({
  userId: z.string().min(1),
  reason: z.unknown(),
});

const forceResetResponseSchema = z.object({
  success: z.boolean(),
  user: selfUserResponseSchema,
});

const handler = adminApi({ adminPermissions: { POST: 'settings:manage' } }).post(
  asyncHandler(async (req, res) => {
    const adminUser = req.user;

    if (!hasAdminPermission(adminUser, 'settings:manage')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId, reason: rawReason } = forceResetBodySchema.parse(req.body);

    // Resetting your own MFA must go through /api/auth/mfa/disable, which requires recent
    // verification and honours enforceMFA.
    if (isSelfOrImpersonator(adminUser, userId)) {
      await denySelfAdminAction(req, {
        action: 'user.mfa.denied',
        attempted: 'user.mfa.reset',
        target: { kind: 'user', id: userId, displayName: adminUser.name || adminUser.username },
        message: 'Use Profile > Settings > Security to turn off your own MFA.',
      });
    }
    const reason = parseAdminActionReason(rawReason);

    let resetBody: unknown;
    // A failed audit write is a server fault (500), not one of the reset's 400s below.
    let auditWriteStarted = false;
    try {
      const { result, removedPasskeys, revokedDevices } = await withTransaction(async () => {
        auditWriteStarted = false;
        // A suspected-compromise reset must not leave an enrolled passkey able to satisfy MFA.
        // Removed in the same transaction as the reset, so a failure leaves MFA intact rather
        // than leaving passkeys behind a reset that succeeded.
        const removedPasskeys = await passkeyCredentialRepository.removeAllForUser(userId);

        const result = await mfaService.forceResetMFA({ targetUserId: userId, adminUser }, userRepository);

        // This is the lost-authenticator / suspected-compromise action, and trusts are
        // deliberately not keyed on tokenVersion (see trustedDevice.ts). Leaving them alive
        // would let a device that already holds a trust cookie keep skipping TOTP against the
        // user's brand-new secret. No cookie to clear: the admin is not the target user.
        const revokedDevices = await trustedDeviceRepository.revokeAllForUser(userId);

        auditWriteStarted = true;
        await recordAdminActionFromRequest(req, {
          action: 'user.mfa.reset',
          target: {
            kind: 'user',
            id: userId,
            displayName: result.user.name || result.user.username || result.user.email || userId,
          },
          summary: "reset the user's MFA",
          reason,
          details: { removedPasskeys, revokedDevices },
        });
        return { result, removedPasskeys, revokedDevices };
      });

      if (revokedDevices > 0) {
        await logAuthAudit(req, {
          userId,
          event: 'trusted_device_revoked',
          actorUserId: adminUser.id,
          metadata: { revoked: revokedDevices, scope: 'all', reason: 'mfa_force_reset' },
        });
      }

      if (removedPasskeys > 0) {
        await logAuthAudit(req, {
          userId,
          event: 'passkey_removed',
          actorUserId: adminUser.id,
          metadata: { removed: removedPasskeys, scope: 'all', reason: 'mfa_force_reset' },
        });
      }

      resetBody = { success: result.success, user: redactUserSecretsForSelf(result.user) };
    } catch (error: any) {
      if (auditWriteStarted) throw error;
      console.error('Error force resetting MFA:', error);
      return res.status(400).json({ error: error.message || 'Failed to reset MFA' });
    }

    // Outside the try so a response-boundary failure stays an opaque 500, not a 400.
    return respond(res, forceResetResponseSchema, resetBody);
  })
);

export default handler;
