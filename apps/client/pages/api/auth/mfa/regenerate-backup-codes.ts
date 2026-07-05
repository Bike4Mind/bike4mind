import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@server/middlewares/rateLimit';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';

const handler = baseApi()
  .use(rateLimit({ limit: 2, windowMs: 24 * 60 * 60 * 1000 })) // 2 regenerations per 24 hours (more secure)
  .post(
    asyncHandler(async (req, res) => {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      try {
        // Load WITH the select:false MFA secrets: regenerateBackupCodes rebuilds the mfa
        // subdocument from this user and persists it via `$set: { mfa }` (full replace).
        // A secret-less read (plain findById) would omit totpSecret and wipe it on write.
        const freshUser = await userRepository.findByIdWithMfaSecrets(user.id);

        if (!freshUser) {
          return res.status(400).json({ error: 'User not found.' });
        }

        const result = await mfaService.regenerateBackupCodes({ user: freshUser }, userRepository);

        res.json(result);
      } catch (error: any) {
        console.error('Error regenerating backup codes:', error);
        res.status(400).json({ error: error.message || 'Failed to regenerate backup codes' });
      }
    })
  );

export default handler;
