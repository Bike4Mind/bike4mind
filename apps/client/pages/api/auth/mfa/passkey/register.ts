import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { logAuthAudit } from '@server/utils/authAudit';
import { completeMfaEnrollment } from '@server/auth/completeMfaEnrollment';
import {
  sendPasskeyError,
  getPasskeyRelyingParty,
  passkeyDeps,
  refusePasskeyEnrollment,
  registrationResponseSchema,
  toPasskeySummary,
} from '@server/auth/passkey';
import * as z from 'zod';

const bodySchema = z.object({
  response: registrationResponseSchema,
  name: z.string().trim().max(64).optional(),
});

/**
 * Step 2 of enrolling a passkey: verify the authenticator's attestation and store the credential.
 * When it is the user's first factor this is an MFA enrollment, finished like verify-setup: a
 * fresh session for this device, plus the backup codes to show once.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler(async (req, res) => {
    const { response, name } = bodySchema.parse(req.body);
    const user = await userRepository.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const refusal = refusePasskeyEnrollment(req.user, user);
    if (refusal) return res.status(403).json({ error: refusal });

    let result: mfaService.FinishPasskeyRegistrationResult;
    try {
      result = await mfaService.finishPasskeyRegistration(
        {
          user,
          rp: getPasskeyRelyingParty(),
          response: response as mfaService.RegistrationResponseJSON,
          name,
          pendingSignIn: !!req.user.mfaPending,
        },
        { ...passkeyDeps, users: userRepository }
      );
    } catch (error) {
      return sendPasskeyError(res, error);
    }

    const { credential } = result;
    await logAuthAudit(req, {
      userId: user.id,
      event: 'passkey_registered',
      metadata: { passkeyId: credential.id, name: credential.name, deviceType: credential.deviceType },
    });
    if (!result.firstFactor) {
      return res.json({ passkey: toPasskeySummary(credential) });
    }

    const { accessToken } = await completeMfaEnrollment(req, res, user);
    const enrolledUser = await userRepository.findById(user.id);
    if (!enrolledUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({
      passkey: toPasskeySummary(credential),
      backupCodes: result.backupCodes,
      accessToken,
      user: redactUserSecretsForSelf(enrolledUser),
    });
  })
);

export default handler;
