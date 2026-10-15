import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@server/middlewares/rateLimit';
import { getPasskeyRelyingParty, passkeyDeps, sendPasskeyError } from '@server/auth/passkey';
import { stepUpMethodsFor } from '@server/auth/stepUp';
import { NotFoundError } from '@server/utils/errors';

/** Step 1 of stepping up with a passkey; step 2 is POST /api/auth/step-up with method 'passkey'. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 20, windowMs: 15 * 60 * 1000, bucket: '/api/auth/step-up/passkey-options' }))
  .post(
    asyncHandler(async (req, res) => {
      const user = await userRepository.findByIdWithPassword(req.user.id);
      if (!user) throw new NotFoundError('User not found');
      if (!(await stepUpMethodsFor(user)).includes('passkey')) {
        return res.status(400).json({ error: 'This verification method is not available for your account.' });
      }
      try {
        const options = await mfaService.startPasskeyAuthentication(
          { userId: user.id, rp: getPasskeyRelyingParty() },
          passkeyDeps
        );
        return res.json(options);
      } catch (error) {
        return sendPasskeyError(res, error);
      }
    })
  );

export default handler;
