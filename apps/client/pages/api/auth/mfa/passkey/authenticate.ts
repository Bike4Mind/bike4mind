import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { completeMfaLogin } from '@server/auth/completeMfaLogin';
import { sendFailedMfaAttempt, sendIfLockedOut } from '@server/auth/mfaLockout';
import {
  asPasskeyError,
  sendPasskeyError,
  authenticationResponseSchema,
  getPasskeyRelyingParty,
  passkeyDeps,
} from '@server/auth/passkey';
import * as z from 'zod';

const bodySchema = z.object({
  response: authenticationResponseSchema,
  rememberDevice: z.boolean().optional(),
});

/**
 * Step 2 of satisfying the MFA challenge with a passkey: the passkey counterpart of
 * /api/auth/mfa/verify, sharing its lockout counter and its session-minting tail.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler(async (req, res) => {
    const { response, rememberDevice } = bodySchema.parse(req.body);

    // Loaded with the select:false MFA secrets: the success path rewrites the `mfa` subdocument.
    const freshUser = await userRepository.findByIdWithMfaSecrets(req.user.id);
    if (!freshUser) {
      return res.status(400).json({ error: 'User not found.' });
    }

    if (sendIfLockedOut(res, freshUser)) return;

    let result: Awaited<ReturnType<typeof mfaService.finishPasskeyAuthentication>>;
    try {
      result = await mfaService.finishPasskeyAuthentication(
        { user: freshUser, rp: getPasskeyRelyingParty(), response: response as mfaService.AuthenticationResponseJSON },
        { ...passkeyDeps, users: userRepository }
      );
    } catch (error) {
      const passkeyError = asPasskeyError(error);
      if (!passkeyError) throw error;

      // Only a presented-but-rejected credential counts toward the lockout; an expired
      // ceremony is the user walking away, not a guess.
      if (passkeyError.code !== 'verification_failed' && passkeyError.code !== 'unknown_credential') {
        return sendPasskeyError(res, error);
      }
      return sendFailedMfaAttempt(res, freshUser.id, { error: passkeyError.message, code: passkeyError.code });
    }

    const { accessToken, deviceRemembered } = await completeMfaLogin(req, res, result.user, { rememberDevice });
    return res.json({
      verified: true,
      deviceRemembered,
      accessToken,
      user: redactUserSecretsForSelf(result.user),
    });
  })
);

export default handler;
