import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import * as z from 'zod';

const forceResetBodySchema = z.object({
  userId: z.string().min(1),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const adminUser = req.user;
    const { userId } = forceResetBodySchema.parse(req.body);

    if (!adminUser) {
      return res.status(401).json({ error: 'User not found' });
    }

    try {
      const result = await mfaService.forceResetMFA({ targetUserId: userId, adminUser }, userRepository);
      res.json({ ...result, user: redactUserSecretsForSelf(result.user) });
    } catch (error: any) {
      console.error('Error force resetting MFA:', error);
      res.status(400).json({ error: error.message || 'Failed to reset MFA' });
    }
  })
);

export default handler;
