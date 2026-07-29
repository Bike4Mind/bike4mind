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

/**
 * Pure enforcement check for the access/refresh token-type separation.
 *
 * A token is acceptable on a given path when its `typ` matches the expected type -
 * OR when it carries no `typ` at all. Tokens minted before the claim existed have no
 * `typ` and are honored (self-expiring grace), so no live session is logged out; they
 * age out within their TTL. Mirrors isTokenVersionCurrent's "missing normalizes to
 * valid" shape. Shared by the refresh path (verifyRefreshToken) and the access path
 * (the passport JWT strategy) so both enforce identically.
 */
export function isTokenTypeAcceptable(tokenType: unknown, expected: 'access' | 'refresh'): boolean {
  return tokenType === undefined || tokenType === expected;
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
      // Token-type claim: `typ` is authoritative (set after the spread so an
      // additionalPayload can't override it). Verifiers reject a token presented on
      // the wrong path (e.g. an access token replayed at the refresh endpoint). Kept
      // last so access and refresh tokens are never interchangeable.
      typ: 'access' as const,
    };
    const accessToken = jwt.sign(payload, this.options.accessTokenSecret, {
      algorithm: 'HS256',
      expiresIn: this.options.accessTokenExpiresIn,
    } as jwt.SignOptions);

    // Carry the same additionalPayload (e.g. impersonatedBy) into the refresh token too, so a
    // token refresh mid-impersonation re-mints an access token that still carries the marker -
    // otherwise the impersonation guard in logout.ts silently stops applying after one refresh.
    const refreshToken = this.createRefreshToken(id, tokenVersion, additionalPayload);

    return { accessToken, refreshToken };
  }

  createRefreshToken(id: string, tokenVersion: number, additionalPayload?: Record<string, unknown>): string {
    // typ set after the spread (authoritative), same ordering rule as createAccessToken's payload.
    return jwt.sign({ id, tokenVersion, ...additionalPayload, typ: 'refresh' as const }, this.options.refreshTokenSecret, {
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

  verifyRefreshToken(
    token: string,
    previousSecret?: string
  ): { userId: string; tokenVersion?: number; impersonatedBy?: string } | null {
    // Pin HS256 (matches verifyToken) and reject any token carrying the mfaPending marker.
    // The mfaPending access token (issued after the first factor, before MFA) is signed with
    // the SAME secret as refresh tokens, so without this guard it could be POSTed to the
    // refresh endpoints and exchanged for a full session - bypassing MFA entirely.
    const decode = (secret: string): { userId: string; tokenVersion?: number; impersonatedBy?: string } | null => {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
      if (payload.mfaPending) return null;
      // Reject a token minted for a different path (e.g. an access token replayed here).
      // Missing typ = legacy pre-claim token, accepted (self-expiring grace). See helper.
      if (!isTokenTypeAcceptable(payload.typ, 'refresh')) return null;
      return { userId: payload.id, tokenVersion: payload.tokenVersion, impersonatedBy: payload.impersonatedBy };
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
