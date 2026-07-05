import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const adminUser = req.user;
    const { userId } = req.body as { userId?: string };

    if (!adminUser) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const result = await mfaService.forceResetMFA({ targetUserId: userId, adminUser }, userRepository);
      res.json(result);
    } catch (error: any) {
      console.error('Error force resetting MFA:', error);
      res.status(400).json({ error: error.message || 'Failed to reset MFA' });
    }
  })
);

export default handler;
