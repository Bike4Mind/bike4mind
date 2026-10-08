import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService, userService } from '@bike4mind/services';
import {
  userRepository,
  adminSettingsRepository,
  authSessionRepository,
  trustedDeviceRepository,
  passkeyCredentialRepository,
} from '@bike4mind/database';
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

      // Phase-1 passkeys are an alternative second factor, so they go with MFA. Removed BEFORE
      // the disable commits: a failure then leaves MFA on, never orphan passkeys that would
      // satisfy MFA again once it is re-enabled. Gated on the disable being allowed, so a
      // refused disable does not strip them.
      let removedPasskeys = 0;
      if (freshUser.mfa?.totpEnabled && mfaService.userCanDisableMFA(freshUser, enforceMFA)) {
        removedPasskeys = await passkeyCredentialRepository.removeAllForUser(freshUser.id);
      }

      const result = await mfaService.disableMFA({ user: freshUser, enforceMFA }, userRepository);

      // Disabling MFA is a security-relevant change: revoke every existing session (including
      // this one) -- bumps tokenVersion AND clears session rows -- forcing re-authentication.
      await userService.revokeUserSessions(freshUser.id, {
        db: { users: userRepository, authSessions: authSessionRepository },
        logger: req.logger,
      });

      // Trusts are vouchers to skip a second factor. With MFA off there is no second
      // factor to skip, so leaving them would silently pre-authorize those devices if
      // MFA is ever re-enabled. Drop them all and clear this browser's cookie.
      const revokedDevices = await trustedDeviceRepository.revokeAllForUser(freshUser.id);
      clearTrustedDeviceCookie(res);

      await logAuthAudit(req, { userId: freshUser.id, event: 'mfa_disabled' });
      if (removedPasskeys > 0) {
        await logAuthAudit(req, {
          userId: freshUser.id,
          event: 'passkey_removed',
          metadata: { removed: removedPasskeys, scope: 'all', reason: 'mfa_disabled' },
        });
      }
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
