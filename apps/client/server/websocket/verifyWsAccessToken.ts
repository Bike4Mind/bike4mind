import { User } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { isTokenTypeAcceptable, isTokenVersionCurrent } from '@bike4mind/services';
import { isRotatedSecretWithinGraceWindow } from '@server/auth/secretRotationGrace';
import { decryptAtRest } from '@bike4mind/utils/security';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { assertAccountStateUsable } from '@server/auth/assertAccountStateUsable';
import { NotFoundError, UnauthorizedError } from '@server/utils/errors';
import jwt from 'jsonwebtoken';

/**
 * Rotation-aware access-token verification for the data subscribe/unsubscribe WS actions.
 *
 * Applies six gates: signature (with the rotation grace window), the `typ` claim, the OAuth `kind`
 * refusal, the `mfaPending` refusal, the tokenVersion kill switch, and assertAccountStateUsable.
 * Signature, `typ`, tokenVersion and account state match the REST strategy (auth/verifyJwtPayload.ts),
 * the CLI verifier (cli/auth.ts verifyJwtToken) and connect.ts. The `kind` and `mfaPending` refusals
 * match the CLI verifier and connect.ts; REST instead surfaces both on the user for oauthRouteGate
 * and the mfaPending block in auth.ts. MUST stay in sync with those paths so a credential refused
 * there cannot ride the socket instead.
 *
 * Unsubscribe shares this verifier, so a blocked account cannot unsubscribe either; disconnect.ts
 * removes its subscribers when the socket closes.
 */
export async function verifyWsAccessToken(accessToken: string | undefined) {
  const secretRotation = await secretRotationRepository.findByKeyNameWithSecret('JWT_SECRET');
  let previousSecret = undefined;
  // Accept the previous key only within the shared rotation grace window. `previousKey`
  // is stored encrypted at rest (see secret-rotations/renewed.ts); decrypt before
  // verifying. Legacy plaintext rows pass through unchanged.
  if (isRotatedSecretWithinGraceWindow(secretRotation?.rotatedAt) && secretRotation?.previousKey) {
    previousSecret = decryptAtRest(secretRotation.previousKey) || undefined;
  }
  const decoded = authTokenGenerator.verifyToken(accessToken!, previousSecret) as jwt.JwtPayload;

  // Missing typ = legacy pre-claim token, accepted (self-expiring grace). See the helper.
  if (!isTokenTypeAcceptable(decoded.typ, 'access')) {
    throw new UnauthorizedError('Invalid token type');
  }

  // A relying-party OAuth access token is scope/audience-bound to OAuth-reachable REST routes
  // (see oauthRouteGate); it is NOT a session credential for the realtime socket. Default-deny it
  // here - the route gate does not cover this surface, so without this check the token would ride
  // the socket as a full session.
  if ((decoded as { kind?: string }).kind === 'oauth') {
    throw new UnauthorizedError('OAuth access tokens are not accepted on the realtime socket');
  }
  if (decoded.mfaPending) {
    throw new UnauthorizedError('MFA verification required');
  }

  const user = await User.findById(decoded.id);
  if (!user) throw new NotFoundError('User not found');

  // Legacy tokens carry no version and normalize to 0, so they stay valid until a revoke
  // bumps the user's version.
  if (!isTokenVersionCurrent(decoded.tokenVersion, user.tokenVersion)) {
    throw new UnauthorizedError('Session expired');
  }
  assertAccountStateUsable(user);

  return user;
}
