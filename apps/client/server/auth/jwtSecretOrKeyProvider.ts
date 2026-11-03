import type { SecretOrKeyProvider } from 'passport-jwt';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { Config } from '@bike4mind/server-utils/utils/config';
import { decryptAtRest } from '@bike4mind/utils/security';
import { authTokenGenerator } from './tokenGenerator';
import { isRotatedSecretWithinGraceWindow } from '@bike4mind/server-utils/auth/secretRotationGrace';

async function resolveJwtSecret(token: string): Promise<string> {
  try {
    authTokenGenerator.verifyToken(token);
    return Config.JWT_SECRET;
  } catch (verificationError) {
    const rotation = await secretRotationRepository.findByKeyNameWithSecret('JWT_SECRET');
    if (!isRotatedSecretWithinGraceWindow(rotation?.rotatedAt) || !rotation?.previousKey) {
      throw verificationError;
    }

    // Rotation rows store the previous key encrypted; legacy plaintext passes through unchanged.
    const previousSecret = decryptAtRest(rotation.previousKey);
    if (!previousSecret) throw verificationError;

    try {
      authTokenGenerator.verifyToken(token, previousSecret);
      return previousSecret;
    } catch {
      throw verificationError;
    }
  }
}

export const jwtSecretOrKeyProvider: SecretOrKeyProvider = (_request, token, done) => {
  // Passport ignores returned promises, so both resolution outcomes must reach its callback.
  void resolveJwtSecret(token).then(secret => done(null, secret), done);
};
