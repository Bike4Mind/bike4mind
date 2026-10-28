import type { NextFunction, Request, Response } from 'express';
import type { IUserDocument } from '@bike4mind/common';
import { isMfaEnrollmentOwed } from '@bike4mind/server-utils/auth/mfaEnforcement';
import { logOAuthError } from '@server/auth/oauthErrorLog';
import { resolveRouteTemplate } from '@server/utils/resolveRouteTemplate';

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
    const grant = (req.user as { oauthGrant?: { scopes: string[]; clientId?: string } } | undefined)?.oauthGrant;
    if (!grant) return next(); // not an OAuth token; unaffected
    const logError = () =>
      logOAuthError(req.logger, {
        route: resolveRouteTemplate(req, { redactAmbiguousQuery: true }),
        clientId: grant.clientId,
        error: 'insufficient_scope',
        status: 403,
      });

    if (!policy?.oauthScopes) {
      logError();
      return res.status(403).json({
        error: 'insufficient_scope',
        error_description: 'This route is not accessible with an OAuth access token',
      });
    }

    const missing = policy.oauthScopes.filter(s => !grant.scopes.includes(s));
    if (missing.length) {
      logError();
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
 * un-credentialed viewer. The shims call admitsOptionalAuthSession below, which adds the enforceMFA
 * enrollment gate - keep this in sync with oauthRouteGate above.
 */
export function admitsOptionalAuthUser(user: unknown): user is Express.User {
  const u = user as { mfaPending?: boolean; oauthGrant?: unknown; impersonatedBy?: string } | null | undefined;
  return !!u && !u.mfaPending && !u.oauthGrant && !u.impersonatedBy;
}

/**
 * The optional-auth shims' admission: admitsOptionalAuthUser plus the enforceMFA enrollment gate
 * (isMfaEnrollmentOwed), so a session that owes enrollment degrades to anonymous there instead of
 * acting as the user. A failed settings read degrades too, the less-privileged posture on a route
 * anonymous viewers can already reach.
 */
export async function admitsOptionalAuthSession(user: unknown): Promise<boolean> {
  if (!admitsOptionalAuthUser(user)) return false;
  const session = user as IUserDocument & { impersonatedBy?: string };
  try {
    return !(await isMfaEnrollmentOwed(session, { impersonatedBy: session.impersonatedBy }));
  } catch {
    return false;
  }
}
