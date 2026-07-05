import jwt, { JwtPayload } from 'jsonwebtoken';

/**
 * Pure enforcement check for the server-side JWT kill switch.
 *
 * True when a token's embedded `tokenVersion` matches the user's current one.
 * Both sides normalize to 0 so pre-field tokens (no embedded version) still match
 * a default-version user, avoiding a mass logout on deploy; once a user's version
 * is bumped (>= 1), such legacy tokens no longer match and the switch fires.
 * Orthogonal to which secret verified the signature (current or rotation path).
 */
export function isTokenVersionCurrent(payloadVersion?: number, userVersion?: number): boolean {
  return (payloadVersion ?? 0) === (userVersion ?? 0);
}

export class AuthTokenGeneratorService {
  constructor(
    private readonly options: {
      accessTokenSecret: string;
      refreshTokenSecret: string;
      accessTokenExpiresIn: string;
      refreshTokenExpiresIn: string;
    }
  ) {}

  createAccessToken(
    id: string,
    tokenVersion: number,
    additionalPayload?: Record<string, unknown>
  ): {
    accessToken: string;
    refreshToken: string;
  } {
    const payload = {
      id,
      tokenVersion,
      ...additionalPayload,
    };
    const accessToken = jwt.sign(payload, this.options.accessTokenSecret, {
      algorithm: 'HS256',
      expiresIn: this.options.accessTokenExpiresIn,
    } as jwt.SignOptions);

    const refreshToken = this.createRefreshToken(id, tokenVersion);

    return { accessToken, refreshToken };
  }

  createRefreshToken(id: string, tokenVersion: number): string {
    return jwt.sign({ id, tokenVersion }, this.options.refreshTokenSecret, {
      algorithm: 'HS256',
      expiresIn: this.options.refreshTokenExpiresIn,
    } as jwt.SignOptions);
  }

  verifyToken(token: string, previousSecret?: string): JwtPayload {
    try {
      return jwt.verify(token, this.options.accessTokenSecret, { algorithms: ['HS256'] }) as JwtPayload;
    } catch (error) {
      if (previousSecret) {
        try {
          return jwt.verify(token, previousSecret, { algorithms: ['HS256'] }) as JwtPayload;
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  verifyRefreshToken(token: string, previousSecret?: string): { userId: string; tokenVersion?: number } | null {
    // Pin HS256 (matches verifyToken) and reject any token carrying the mfaPending marker.
    // The mfaPending access token (issued after the first factor, before MFA) is signed with
    // the SAME secret as refresh tokens, so without this guard it could be POSTed to the
    // refresh endpoints and exchanged for a full session - bypassing MFA entirely.
    const decode = (secret: string): { userId: string; tokenVersion?: number } | null => {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
      if (payload.mfaPending) return null;
      return { userId: payload.id, tokenVersion: payload.tokenVersion };
    };
    try {
      return decode(this.options.refreshTokenSecret);
    } catch (error) {
      if (previousSecret) {
        try {
          return decode(previousSecret);
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}
