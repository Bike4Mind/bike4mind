import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository, trustedDeviceRepository, passkeyCredentialRepository } from '@bike4mind/database';
import { redactUserSecretsForSelf, selfUserResponseSchema } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { logAuthAudit } from '@server/utils/authAudit';
import * as z from 'zod';

const forceResetBodySchema = z.object({
  userId: z.string().min(1),
});

const forceResetResponseSchema = z.object({
  success: z.boolean(),
  user: selfUserResponseSchema,
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const adminUser = req.user;

    if (!adminUser?.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId } = forceResetBodySchema.parse(req.body);

    // Resetting your own MFA must go through /api/auth/mfa/disable, which requires recent
    // verification and honours enforceMFA. Ids compare case-insensitively: Mongo resolves an
    // upper-case hex id to the same user.
    if (adminUser.id.toLowerCase() === userId.toLowerCase()) {
      return res.status(403).json({ error: 'Use /api/auth/mfa/disable to turn off your own MFA.' });
    }

    let resetBody: unknown;
    try {
      // A suspected-compromise reset must not leave an enrolled passkey able to satisfy MFA.
      // Removed before the reset commits, so a failure here leaves MFA intact rather than
      // leaving passkeys behind a reset that succeeded.
      const removedPasskeys = await passkeyCredentialRepository.removeAllForUser(userId);

      const result = await mfaService.forceResetMFA({ targetUserId: userId, adminUser }, userRepository);

      // This is the lost-authenticator / suspected-compromise action, and trusts are
      // deliberately not keyed on tokenVersion (see trustedDevice.ts). Leaving them alive
      // would let a device that already holds a trust cookie keep skipping TOTP against the
      // user's brand-new secret. No cookie to clear: the admin is not the target user.
      const revokedDevices = await trustedDeviceRepository.revokeAllForUser(userId);
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
      console.error('Error force resetting MFA:', error);
      return res.status(400).json({ error: error.message || 'Failed to reset MFA' });
    }

    // Outside the try so a response-boundary failure stays an opaque 500, not a 400.
    return respond(res, forceResetResponseSchema, resetBody);
  })
);

export default handler;
