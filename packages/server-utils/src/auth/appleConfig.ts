import { createPrivateKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Config } from '../utils/config';

export const APPLE_ISSUER = 'https://appleid.apple.com';

export type AppleConfig = {
  /** The Services ID registered for Sign in with Apple. */
  clientId: string;
  teamId: string;
  keyId: string;
  /** PEM contents of the .p8 key, real newlines. */
  privateKey: string;
};

const isSet = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '' && value !== 'not-configured';

/** Secret stores often flatten the PEM onto one line with literal `\n` escapes. */
const normalizePem = (pem: string): string => pem.replace(/\\n/g, '\n').trim();

/** True when the PEM is a P-256 EC private key, the only key ES256 signing accepts. */
const isEs256PrivateKey = (pem: string): boolean => {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
};

// Read on every config lookup (public settings, auth routes), so the misconfig is reported once per process.
let invalidKeyReported = false;

/**
 * The Apple credentials, or null when any is unset or the key is unusable - the signal to leave Sign in
 * with Apple off. The key is validated here, not left to the first signing, because the strategy mints a
 * client secret at module load and a throw there would take every API route down with it.
 */
export function getAppleConfig(): AppleConfig | null {
  const { APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY } = Config;
  if (!isSet(APPLE_CLIENT_ID) || !isSet(APPLE_TEAM_ID) || !isSet(APPLE_KEY_ID) || !isSet(APPLE_PRIVATE_KEY)) {
    return null;
  }
  const privateKey = normalizePem(APPLE_PRIVATE_KEY);
  if (!isEs256PrivateKey(privateKey)) {
    if (!invalidKeyReported) {
      invalidKeyReported = true;
      console.error(
        '[AUTH] APPLE_PRIVATE_KEY is set but is not a valid P-256 EC private key; Sign in with Apple is disabled. ' +
          'Set it to the full .p8 PEM contents, including the BEGIN/END PRIVATE KEY lines.'
      );
    }
    return null;
  }
  return {
    clientId: APPLE_CLIENT_ID,
    teamId: APPLE_TEAM_ID,
    keyId: APPLE_KEY_ID,
    privateKey,
  };
}

/**
 * Apple has no static client secret: it is an ES256 JWT signed with the .p8 key, valid for at most six
 * months. Minted short-lived and on demand so no long-lived bearer exists at rest.
 */
export function generateAppleClientSecret(config: AppleConfig, ttlSeconds = 60 * 60): string {
  return jwt.sign({}, config.privateKey, {
    algorithm: 'ES256',
    keyid: config.keyId,
    issuer: config.teamId,
    audience: APPLE_ISSUER,
    subject: config.clientId,
    expiresIn: ttlSeconds,
  });
}
