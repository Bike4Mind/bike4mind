import { userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getStepUpUntil, stepUpMethodsFor } from '@server/auth/stepUp';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';

/** Which proofs this user may step up with, and whether this session is already stepped up. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 60, windowMs: 15 * 60 * 1000, bucket: '/api/auth/step-up/options' }))
  .get(
    asyncHandler(async (req, res) => {
      const user = await userRepository.findByIdWithPassword(req.user.id);
      if (!user) throw new NotFoundError('User not found');
      const [methods, stepUpUntil] = await Promise.all([stepUpMethodsFor(user), getStepUpUntil(req.user)]);
      return res.json({ methods, stepUpUntil: stepUpUntil?.toISOString() ?? null });
    })
  );

export default handler;
