import type { NextFunction, Request, Response } from 'express';

export interface OAuthRoutePolicy {
  /**
   * OAuth reachability for this route:
   * - undefined (default): first-party-only. A relying-party OAuth token is rejected (403).
   * - [] : reachable by any OAuth token, no specific scope required.
   * - ['profile', ...] : reachable only when the token's grant includes ALL listed scopes.
   */
  oauthScopes?: string[];
}

/**
 * Default-deny gate for relying-party OAuth access tokens. Runs after `auth` sets req.user.
 *
 * First-party sessions carry no oauthGrant marker (verifyJwtPayload only sets it for kind==='oauth'
 * tokens), so this is a no-op for them and for API-key callers - they are never affected. An OAuth
 * token reaches only routes that opt in via `oauthScopes`, and only when the token's granted scopes
 * satisfy the route's requirement. This is the OAuth choke point for the NORMAL authenticated chain
 * (routes mounted with `auth`); the parallel choke point for optional-auth (`auth: false`) routes,
 * which never run this gate, is admitsOptionalAuthUser below. The two together cover every path an
 * OAuth token (otherwise a valid Bearer for every JWT-authed route) can reach.
 */
export function oauthRouteGate(policy?: OAuthRoutePolicy) {
  return (req: Request, res: Response, next: NextFunction) => {
    const grant = (req.user as { oauthGrant?: { scopes: string[] } } | undefined)?.oauthGrant;
    if (!grant) return next(); // not an OAuth token; unaffected

    if (!policy?.oauthScopes) {
      return res.status(403).json({
        error: 'insufficient_scope',
        error_description: 'This route is not accessible with an OAuth access token',
      });
    }

    const missing = policy.oauthScopes.filter(s => !grant.scopes.includes(s));
    if (missing.length) {
      return res
        .status(403)
        .json({ error: 'insufficient_scope', error_description: `Requires OAuth scope(s): ${missing.join(' ')}` });
    }

    next();
  };
}

/**
 * Should a JWT-authenticated user be admitted as `req.user` on an OPTIONAL-auth (`auth: false`)
 * route? Those routes bypass the normal chain's mfaPending block AND oauthRouteGate above, so every
 * optional-auth shim must mirror those default-denies itself or it becomes a bypass: a pre-MFA
 * session or a relying-party OAuth token would otherwise act as a full user (read a subject user's
 * PRIVATE published artifacts, mint a passphrase gate-proof cookie, or create/edit annotations).
 * Returns false for both markers; such callers fall through to the same anonymous posture as an
 * un-credentialed viewer. This is the single choke point every optional-auth shim shares - keep it
 * in sync with oauthRouteGate above.
 */
export function admitsOptionalAuthUser(user: unknown): user is Express.User {
  const u = user as { mfaPending?: boolean; oauthGrant?: unknown } | null | undefined;
  return !!u && !u.mfaPending && !u.oauthGrant;
}
