import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { User, userRepository, adminSettingsRepository } from '@bike4mind/database';
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
      await User.updateOne({ _id: freshUser.id }, { $inc: { tokenVersion: 1 } });

      await logAuthAudit(req, { userId: freshUser.id, event: 'mfa_disabled' });

      res.json(result);
    } catch (error: any) {
      console.error('Error disabling MFA:', error);
      res.status(400).json({ error: error.message || 'Failed to disable MFA' });
    }
  })
);

export default handler;
