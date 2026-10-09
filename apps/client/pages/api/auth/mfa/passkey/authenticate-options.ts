import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@server/middlewares/rateLimit';
import { mfaService } from '@bike4mind/services';
import { sendPasskeyError, getPasskeyRelyingParty, passkeyDeps } from '@server/auth/passkey';

/**
 * Step 1 of satisfying the MFA challenge with a passkey. Reachable with an mfaPending token
 * (see the allowlist in server/auth/auth.ts).
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 20, windowMs: 15 * 60 * 1000 }))
  .post(
    asyncHandler(async (req, res) => {
      try {
        const options = await mfaService.startPasskeyAuthentication(
          { userId: req.user.id, rp: getPasskeyRelyingParty() },
          passkeyDeps
        );
        return res.json(options);
      } catch (error) {
        return sendPasskeyError(res, error);
      }
    })
  );

export default handler;
