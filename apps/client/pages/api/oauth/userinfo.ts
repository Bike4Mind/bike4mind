/**
 * GET /api/oauth/userinfo
 *
 * OIDC UserInfo endpoint. Returns profile claims for the authenticated B4M user.
 * Requires a valid B4M Bearer access token.
 */

import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  return res.json({
    sub: user.id,
    email: user.email,
    name: user.username || user.email?.split('@')[0],
    picture: user.oauthCredentials?.picture ?? null,
    email_verified: user.emailVerified ?? false,
  });
});

export const config = { api: { externalResolver: true } };
export default handler;
