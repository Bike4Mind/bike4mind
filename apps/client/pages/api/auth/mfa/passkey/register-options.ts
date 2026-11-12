import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { getPasskeyRelyingParty, passkeyDeps, refusePasskeyEnrollment, sendPasskeyError } from '@server/auth/passkey';
import { isFreshSignIn, stepUpGate } from '@server/auth/stepUp';

/**
 * Step 1 of enrolling a passkey: issue the creation options and hold their challenge server-side.
 * Requires recent verification: a passkey is a durable second factor that outlives session
 * revocation. Sign-in enrollment of a first factor skips step-up exactly as the app setup route
 * does (see setup.ts); refusePasskeyEnrollment keeps that skip from adding a passkey ahead of a
 * pending challenge.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(stepUpGate({ skip: async req => !!req.user?.mfaPending || (!!req.user && (await isFreshSignIn(req.user))) }))
  .use(rateLimit({ limit: 10, windowMs: 15 * 60 * 1000 }))
  .post(
    asyncHandler(async (req, res) => {
      const user = await userRepository.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const refusal = refusePasskeyEnrollment(req.user, user);
      if (refusal) return res.status(403).json({ error: refusal });

      try {
        const options = await mfaService.startPasskeyRegistration({ user, rp: getPasskeyRelyingParty() }, passkeyDeps);
        return res.json(options);
      } catch (error) {
        return sendPasskeyError(res, error);
      }
    })
  );

export default handler;
