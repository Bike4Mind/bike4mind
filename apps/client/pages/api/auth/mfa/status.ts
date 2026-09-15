import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    try {
      // Get fresh user data (incl. select:false MFA secrets) for the backup-code count
      const freshUser = await userRepository.findByIdWithMfaSecrets(user.id);
      if (!freshUser) {
        return res.status(404).json({ error: 'User not found in database' });
      }

      const enforceMFASetting = await adminSettingsRepository.findBySettingName('enforceMFA');
      const enforceMFA = enforceMFASetting?.settingValue === 'true' || false;

      const status = mfaService.getMFAStatus({ user: freshUser, enforceMFA });
      res.json(status);
    } catch (error: any) {
      console.error('Error getting MFA status:', error);
      res.status(500).json({ error: error.message || 'Failed to get MFA status' });
    }
  })
);

export default handler;
