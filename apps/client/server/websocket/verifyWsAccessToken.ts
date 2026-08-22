import { User } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { isTokenTypeAcceptable, isTokenVersionCurrent } from '@bike4mind/services';
import { isRotatedSecretWithinGraceWindow } from '@server/auth/secretRotationGrace';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { NotFoundError, UnauthorizedError } from '@server/utils/errors';
import jwt from 'jsonwebtoken';

/**
 * Rotation-aware access-token verification for the data subscribe/unsubscribe WS actions.
 *
 * Applies the same three gates as the REST strategy (auth/verifyJwtPayload.ts) and the CLI
 * verifier (cli/auth.ts verifyJwtToken): signature (with the rotation grace window), the
 * `typ` claim, and the tokenVersion kill switch. MUST stay in sync with those two - any gate
 * missing here lets a revoked or wrong-type token ride the socket after REST already refused it.
 */
export async function verifyWsAccessToken(accessToken: string | undefined) {
  const secretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
  let previousSecret = undefined;
  // Accept the previous key only within the shared rotation grace window.
  if (isRotatedSecretWithinGraceWindow(secretRotation?.rotatedAt)) {
    previousSecret = secretRotation?.previousKey;
  }
  const decoded = authTokenGenerator.verifyToken(accessToken!, previousSecret) as jwt.JwtPayload;

  // Missing typ = legacy pre-claim token, accepted (self-expiring grace). See the helper.
  if (!isTokenTypeAcceptable(decoded.typ, 'access')) {
    throw new UnauthorizedError('Invalid token type');
  }

  const user = await User.findById(decoded.id);
  if (!user) throw new NotFoundError('User not found');

  // Legacy tokens carry no version and normalize to 0, so they stay valid until a revoke
  // bumps the user's version.
  if (!isTokenVersionCurrent(decoded.tokenVersion, user.tokenVersion)) {
    throw new UnauthorizedError('Session expired');
  }

  return user;
}
