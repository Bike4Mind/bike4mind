import { User } from '@bike4mind/database';
import { isTokenVersionCurrent, isTokenTypeAcceptable } from '@bike4mind/services';

export interface JwtPayloadClaims {
  id: string;
  tokenVersion?: number;
  mfaPending?: boolean;
  impersonatedBy?: string;
  typ?: string;
}

/**
 * passport-jwt verify callback for the JwtStrategy in auth.ts. Extracted to its own module
 * (rather than inline) so the tokenVersion kill switch and impersonatedBy propagation can be
 * unit-tested without pulling in auth.ts's SAML/OAuth strategy registration side effects.
 */
export async function verifyJwtPayload(
  jwt_payload: JwtPayloadClaims,
  done: (err: unknown, user?: unknown) => void
): Promise<void> {
  try {
    // Token-type guard: reject a token minted for a different path (e.g. a refresh
    // token presented as a Bearer access token). Missing typ = legacy pre-claim token,
    // accepted (self-expiring grace); the mfaPending access token is also typ-less and
    // handled by the mfaPending gate below. Shares isTokenTypeAcceptable with the
    // refresh path (verifyRefreshToken) so those two REST verifiers enforce identically.
    // NOTE: the WS/CLI verifiers (verifyToken / server/cli/auth.ts verifyJwtToken) do
    // NOT yet apply this check - tracked as a follow-up, not covered here.
    if (!isTokenTypeAcceptable(jwt_payload.typ, 'access')) {
      return done(null, false);
    }
    const user = await User.findById(jwt_payload.id);
    if (user) {
      if (user.isSystem) return done(null, false);
      // Server-side kill switch: reject tokens whose embedded tokenVersion
      // is stale relative to the user's current version. Tokens issued
      // before this field existed carry no version and normalize to 0, so
      // they remain valid until the user's version is bumped by a revoke.
      if (!isTokenVersionCurrent(jwt_payload.tokenVersion, user.tokenVersion)) {
        return done(null, false);
      }
      (user as any).mfaPending = !!jwt_payload.mfaPending;
      // Propagate the impersonation marker (set by loginAs) so request handlers
      // can distinguish an admin-driven session from the real customer's - see logout.ts.
      (user as any).impersonatedBy = jwt_payload.impersonatedBy;
      return done(null, user);
    } else {
      return done(null, false);
    }
  } catch (err) {
    // Catch transient DB errors (EPIPE, socket closed) and treat as
    // auth failure to prevent leaking internal details to clients
    // and to avoid unhandled promise rejections in Lambda
    return done(null, false);
  }
}
