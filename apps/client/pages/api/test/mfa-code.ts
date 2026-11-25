import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { userRepository } from '@bike4mind/database';
import { isValidE2eTestSecret } from '@server/auth/e2eTestSecret';
import { TOTP_STEP_SECONDS, totpCode } from '@bike4mind/auth/mfaService/totp';
import { Request } from 'express';

/**
 * TEST-ONLY: returns a TOTP code the server will accept for an MFA-enrolled test account, so the
 * e2e suite can sign in to any enrolled account, including standing accounts that outlive the run
 * that enrolled them. Same guards as /api/test/otc-code.
 *
 * The code is for the first step after the account's last accepted one (the replay guard rejects
 * any step at or below it). Nothing is claimed here; the sign-in that submits the code claims it.
 */
const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req: Request, res) => {
    if (!isE2EEnabled()) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!isValidE2eTestSecret(req.headers['x-e2e-cleanup-secret'])) {
      return res.status(401).json({ error: 'Invalid cleanup secret' });
    }

    const emailRaw = req.query.email;
    const email = typeof emailRaw === 'string' ? emailRaw.toLowerCase().trim() : '';
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required' });
    }
    if (!/-e2e@test\.com$/i.test(email)) {
      return res.status(400).json({ error: 'mfa-code is only available for -e2e@test.com accounts' });
    }

    const found = await userRepository.findByEmail(email);
    const user = found ? await userRepository.findByIdWithMfaSecrets(found.id) : null;
    const secret = user?.mfa?.totpEnabled ? user.mfa.totpSecret : undefined;
    if (!user || !secret) {
      return res.status(404).json({ error: 'No TOTP factor is enabled for this email' });
    }

    const nowMs = Date.now();
    const currentStep = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
    const step = Math.max(currentStep, (user.totpLastStep ?? -1) + 1);
    // Verification accepts one step either side of now, so a later step is not yet usable.
    if (step > currentStep + 1) {
      const retryAfterMs = (step - 1) * TOTP_STEP_SECONDS * 1000 - nowMs;
      return res.status(409).json({ error: 'The next unused code is not valid yet', retryAfterMs });
    }

    const code = totpCode(secret, step);
    return res.status(200).json({ code, step });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
