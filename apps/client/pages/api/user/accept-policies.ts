import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';

/**
 * Records the authenticated user's acceptance of the current AUP/ToS + 18+ age attestation
 * (P0-B abuse gate). Thin route: all business logic (version stamping, age validation)
 * lives in userService.recordPolicyAcceptance. On the consent-gate allowlist (auth.ts) so a
 * brand-new OAuth/SAML/Okta account - blocked from all other authenticated surface - can reach it.
 */
const handler = baseApi().post(async (req: Request<unknown, unknown, { ageAttestation?: boolean }>, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  // BadRequestError (age not attested) / NotFoundError are mapped to 400/404 by baseApi's
  // errorHandler - no need to catch here.
  const updatedUser = await userService.recordPolicyAcceptance(
    { userId: user.id, ageAttestation: req.body?.ageAttestation === true },
    { db: { users: userRepository } }
  );

  return res.status(200).json({ user: updatedUser });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
