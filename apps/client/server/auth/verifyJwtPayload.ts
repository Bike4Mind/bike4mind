import { User } from '@bike4mind/database';
import { isTokenVersionCurrent, isTokenTypeAcceptable } from '@bike4mind/services';

export interface JwtPayloadClaims {
  id: string;
  tokenVersion?: number;
  mfaPending?: boolean;
  impersonatedBy?: string;
  typ?: string;
  /** AuthSession id this token belongs to (present on session-store tokens; absent on legacy
   *  and mfaPending tokens). Surfaced on req.user so per-device logout can revoke THIS session. */
  sid?: string;
  /** 'oauth' marks a relying-party OAuth access token (see oauth/token.ts). Present only on those;
   *  its presence is what the route gate keys default-deny on. Absent on first-party sessions. */
  kind?: string;
  /** OAuth client the token was issued to; present iff kind==='oauth'. */
  client_id?: string;
  /** Space-delimited granted scopes (RFC 9068 sec 2.2.3); present iff kind==='oauth'. */
  scope?: string;
  /** Resource audience (RFC 9068); present iff kind==='oauth'. */
  aud?: string;
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
    // refresh path (verifyRefreshToken), the CLI verifier (cli/auth.ts verifyJwtToken) and
    // the WS verifiers (websocket/verifyWsAccessToken.ts, websocket/connect.ts) so every
    // verifier enforces identically.
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
      // Surface the session id so per-device logout can revoke exactly THIS session
      // (see logout.ts + users/me/sessions.ts) without re-decoding the token.
      (user as any).sid = jwt_payload.sid;
      // An OAuth (relying-party) access token is recognized here but NOT rejected: first-party
      // sessions carry no `kind` and must still pass. The marker is surfaced so the route gate
      // (oauthRouteGate) can default-deny it everywhere except OAuth-reachable routes.
      if (jwt_payload.kind === 'oauth') {
        (user as any).oauthGrant = {
          clientId: jwt_payload.client_id,
          scopes: (jwt_payload.scope ?? '').split(' ').filter(Boolean),
          aud: jwt_payload.aud,
        };
      }
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
