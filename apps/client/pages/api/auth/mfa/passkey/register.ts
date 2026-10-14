import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { logAuthAudit } from '@server/utils/authAudit';
import {
  sendPasskeyError,
  getPasskeyRelyingParty,
  passkeyDeps,
  registrationResponseSchema,
  toPasskeySummary,
} from '@server/auth/passkey';
import * as z from 'zod';

const bodySchema = z.object({
  response: registrationResponseSchema,
  name: z.string().trim().max(64).optional(),
});

/** Step 2 of enrolling a passkey: verify the authenticator's attestation and store the credential. */
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler(async (req, res) => {
    const { response, name } = bodySchema.parse(req.body);
    const user = await userRepository.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    try {
      const passkey = await mfaService.finishPasskeyRegistration(
        { user, rp: getPasskeyRelyingParty(), response: response as mfaService.RegistrationResponseJSON, name },
        passkeyDeps
      );
      await logAuthAudit(req, {
        userId: user.id,
        event: 'passkey_registered',
        metadata: { passkeyId: passkey.id, name: passkey.name, deviceType: passkey.deviceType },
      });
      return res.json({ passkey: toPasskeySummary(passkey) });
    } catch (error) {
      return sendPasskeyError(res, error);
    }
  })
);

export default handler;
