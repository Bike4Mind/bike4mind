import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { getPasskeyRelyingParty, passkeyDeps, sendPasskeyError } from '@server/auth/passkey';
import { stepUpGate } from '@server/auth/stepUp';

/**
 * Step 1 of enrolling a passkey: issue the creation options and hold their challenge server-side.
 * Requires recent verification: a passkey is a durable second factor that outlives session
 * revocation.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(stepUpGate())
  .use(rateLimit({ limit: 10, windowMs: 15 * 60 * 1000 }))
  .post(
    asyncHandler(async (req, res) => {
      const user = await userRepository.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      try {
        const options = await mfaService.startPasskeyRegistration({ user, rp: getPasskeyRelyingParty() }, passkeyDeps);
        return res.json(options);
      } catch (error) {
        return sendPasskeyError(res, error);
      }
    })
  );

export default handler;
