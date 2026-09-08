import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository, trustedDeviceRepository } from '@bike4mind/database';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { logAuthAudit } from '@server/utils/authAudit';
import * as z from 'zod';

const forceResetBodySchema = z.object({
  userId: z.string().min(1),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const adminUser = req.user;

    if (!adminUser?.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { userId } = forceResetBodySchema.parse(req.body);

    try {
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

      res.json({ ...result, user: redactUserSecretsForSelf(result.user) });
    } catch (error: any) {
      console.error('Error force resetting MFA:', error);
      res.status(400).json({ error: error.message || 'Failed to reset MFA' });
    }
  })
);

export default handler;
