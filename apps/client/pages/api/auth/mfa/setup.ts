import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@server/middlewares/rateLimit';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';

const handler = baseApi()
  .use(rateLimit({ limit: 3, windowMs: 15 * 60 * 1000 })) // 3 setups per 15 minutes
  .post(
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

        // MFA already enabled is an expected client/server state mismatch (e.g. a
        // stale UI that still offers "Enable"), not a server fault. Respond with a
        // graceful 409 Conflict instead of letting the service throw - this keeps
        // it out of the error log so it doesn't trip a LiveOps alert.
        if (freshUser.mfa?.totpEnabled) {
          return res.status(409).json({ error: 'MFA is already enabled for this account.' });
        }

        const result = await mfaService.setupMFA(
          { user: freshUser, appName: process.env.APP_NAME || '' },
          userRepository
        );

        res.json(result);
      } catch (error: any) {
        console.error('Error setting up MFA:', error);
        res.status(400).json({ error: error.message || 'Failed to setup MFA' });
      }
    })
  );

export default handler;
