import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';

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

      const result = await mfaService.cancelMFASetup(freshUser, userRepository);
      res.json(result);
    } catch (error: any) {
      console.error('Error canceling MFA setup:', error);
      res.status(400).json({ error: error.message || 'Failed to cancel MFA setup' });
    }
  })
);

export default handler;
