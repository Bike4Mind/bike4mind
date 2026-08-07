import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository, adminSettingsRepository, trustedDeviceRepository } from '@bike4mind/database';
import { clearTrustedDeviceCookie } from '@server/auth/trustedDevice';
import { logAuthAudit } from '@server/utils/authAudit';

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    try {
      // Get fresh user data from database to ensure we have latest MFA state
      const freshUser = await userRepository.findById(user.id);
      if (!freshUser) {
        return res.status(404).json({ error: 'User not found in database' });
      }

      const enforceMFASetting = await adminSettingsRepository.findBySettingName('enforceMFA');
      const enforceMFA = enforceMFASetting?.settingValue === 'true' || false;

      const result = await mfaService.disableMFA({ user: freshUser, enforceMFA }, userRepository);

      // Disabling MFA is a security-relevant change: bump tokenVersion to
      // invalidate every existing session (including this one), forcing
      // re-authentication.
      await userRepository.incrementTokenVersion(freshUser.id);

      // Trusts are vouchers to skip a second factor. With MFA off there is no second
      // factor to skip, so leaving them would silently pre-authorize those devices if
      // MFA is ever re-enabled. Drop them all and clear this browser's cookie.
      const revokedDevices = await trustedDeviceRepository.revokeAllForUser(freshUser.id);
      clearTrustedDeviceCookie(res);

      await logAuthAudit(req, { userId: freshUser.id, event: 'mfa_disabled' });
      if (revokedDevices > 0) {
        await logAuthAudit(req, {
          userId: freshUser.id,
          event: 'trusted_device_revoked',
          metadata: { revoked: revokedDevices, scope: 'all', reason: 'mfa_disabled' },
        });
      }

      res.json(result);
    } catch (error: any) {
      console.error('Error disabling MFA:', error);
      res.status(400).json({ error: error.message || 'Failed to disable MFA' });
    }
  })
);

export default handler;
