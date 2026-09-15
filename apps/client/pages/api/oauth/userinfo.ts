/**
 * GET /api/oauth/userinfo
 *
 * OIDC UserInfo endpoint. Returns profile claims for the authenticated B4M user.
 * Requires a valid B4M Bearer access token.
 */

import { baseApi } from '@server/middlewares/baseApi';

// OIDC identity endpoint: the one route a relying-party OAuth token is meant to reach. Requires
// the openid scope; every other JWT-authed route stays first-party-only by default (oauthRouteGate).
const handler = baseApi({ auth: true, oauthScopes: ['openid'] }).get(async (req, res) => {
  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  // Release claims only for the scopes the token was actually granted (OIDC Core 5.4): `email`
  // for the email claims, `profile` for name/picture. openid-only tokens get sub alone. Mirrors
  // the id_token gating in generateIdToken; the grant scopes are stamped on req.user by
  // verifyJwtPayload (oauthGrant).
  const scopes: string[] = user.oauthGrant?.scopes ?? [];
  const claims: Record<string, unknown> = { sub: user.id };
  if (scopes.includes('email')) {
    claims.email = user.email;
    claims.email_verified = user.emailVerified ?? false;
  }
  if (scopes.includes('profile')) {
    claims.name = user.username || user.email?.split('@')[0];
    claims.picture = user.oauthCredentials?.picture ?? null;
  }

  return res.json(claims);
});

export const config = { api: { externalResolver: true } };
export default handler;
