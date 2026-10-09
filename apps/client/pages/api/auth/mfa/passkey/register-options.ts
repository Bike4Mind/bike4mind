import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@server/middlewares/rateLimit';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { getPasskeyRelyingParty, passkeyDeps, sendPasskeyError } from '@server/auth/passkey';
import { sendFailedMfaAttempt, sendIfLockedOut } from '@server/auth/mfaLockout';
import * as z from 'zod';

const bodySchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'),
});

/**
 * Step 1 of enrolling a passkey: issue the creation options and hold their challenge server-side.
 * Gated on a fresh authenticator code, so a stolen session alone cannot plant a durable second
 * factor (a passkey outlives session revocation). Backup codes are not accepted: they are
 * single-use recovery codes, not a step-up credential.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 10, windowMs: 15 * 60 * 1000 }))
  .post(
    asyncHandler(async (req, res) => {
      const { token } = bodySchema.parse(req.body);
      const user = await userRepository.findByIdWithMfaSecrets(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (sendIfLockedOut(res, user)) return;

      if (user.mfa?.totpEnabled && !mfaService.verifyTOTPToken(user.mfa.totpSecret, token)) {
        return sendFailedMfaAttempt(res, user.id, { error: 'Invalid authenticator code.' });
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
