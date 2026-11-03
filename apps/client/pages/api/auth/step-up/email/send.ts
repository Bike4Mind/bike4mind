import { userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { stepUpMethodsFor, stepUpUnavailableError } from '@server/auth/stepUp';
import { sendStepUpEmailCode } from '@server/auth/stepUpEmail';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';

/**
 * Email a step-up code to the account's current address (read from the database, never from the
 * request). Step 2 is POST /api/auth/step-up with method 'email'.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 5, windowMs: 15 * 60 * 1000, bucket: '/api/auth/step-up/email/send' }))
  .post(
    asyncHandler(async (req, res) => {
      const sid = req.user.sid;
      if (!sid) throw stepUpUnavailableError();

      const user = await userRepository.findByIdWithPassword(req.user.id);
      if (!user) throw new NotFoundError('User not found');
      if (!user.email || !(await stepUpMethodsFor(user)).includes('email')) {
        return res.status(400).json({ error: 'This verification method is not available for your account.' });
      }

      const sent = await sendStepUpEmailCode({ sid, userId: user.id, email: user.email });
      if (!sent) throw stepUpUnavailableError();
      return res.json(sent);
    })
  );

export default handler;
