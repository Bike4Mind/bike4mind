import {
  adminSignupGrantPendingSchema,
  BadRequestError,
  NotFoundError,
  resolveSignupGrantSchedule,
} from '@bike4mind/common';
import { adminSettingsRepository, heldCreditRewardRepository, userRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { buildSignupGrantPending } from '@server/credits/signupGrantPending';
import { respond } from '@server/utils/respond';

/**
 * GET /api/admin/users/[userId]/signup-grant-pending
 *
 * What the account still has coming from the signup grant (schedule, held tranche, queued rewards, block state)
 * and which of the four admin actions currently apply. Block state is read here and nowhere else: the user's
 * own payload strips it.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler(async (req, res) => {
    const { userId } = req.query as { userId?: string | string[] };
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

    const user = await userRepository.findById(userId.toLowerCase());
    if (!user) throw new NotFoundError('User not found');

    const [schedule, rewards] = await Promise.all([
      resolveSignupGrantSchedule(adminSettingsRepository),
      heldCreditRewardRepository.totalsForUser(user.id),
    ]);

    return respond(
      res,
      adminSignupGrantPendingSchema,
      buildSignupGrantPending({ user, schedule, rewards, viewerIsAdmin: req.user?.isAdmin === true })
    );
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
