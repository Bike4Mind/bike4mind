/**
 * GET /api/oauth/userinfo
 *
 * OIDC UserInfo endpoint. Returns profile claims for the authenticated B4M user.
 * Requires a valid B4M Bearer access token.
 */

import { baseApi } from '@server/middlewares/baseApi';
import { releasedIdentityClaims } from '@server/auth/oauthServer';

// OIDC identity endpoint: the one route a relying-party OAuth token is meant to reach. Requires
// the openid scope; every other JWT-authed route stays first-party-only by default (oauthRouteGate).
const handler = baseApi({ auth: true, oauthScopes: ['openid'] }).get(async (req, res) => {
  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  // Release claims through the shared decision so this stays in lockstep with the id_token
  // (generateIdToken). A relying-party OAuth token is scope-limited (email -> email claims,
  // profile -> name/picture; openid-only gets sub alone); a first-party / legacy token carries no
  // oauthGrant marker (verifyJwtPayload stamps it only for kind==='oauth' tokens), so it is not
  // scope-limited and keeps the full claim set - the pre-scoping behavior, unchanged.
  const grant = user.oauthGrant as { scopes?: string[] } | undefined;
  const release = releasedIdentityClaims({ scopes: grant?.scopes ?? [], scopeLimited: !!grant });
  const claims: Record<string, unknown> = { sub: user.id };
  if (release.email) {
    claims.email = user.email;
    claims.email_verified = user.emailVerified ?? false;
  }
  if (release.profile) {
    claims.name = user.username || user.email?.split('@')[0];
    claims.picture = user.oauthCredentials?.picture ?? null;
  }

  return res.json(claims);
});

export const config = { api: { externalResolver: true } };
export default handler;
