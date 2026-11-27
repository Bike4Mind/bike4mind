/**
 * GET /api/oauth/jwks
 *
 * JWKS (JSON Web Key Set) endpoint. Mapped from /.well-known/jwks.json
 * via next.config.mjs rewrites. Used by Cognito and other OIDC clients
 * to verify RS256-signed ID tokens.
 */

import { baseApi } from '@server/middlewares/baseApi';
import { getJwks } from '@server/auth/oauthServer';

const handler = baseApi({ auth: false }).get(async (_req, res) => {
  const { jwks, cacheable } = await getJwks();
  res.setHeader('Cache-Control', cacheable ? 'public, max-age=3600' : 'no-store');
  return res.json(jwks);
});

export const config = { api: { externalResolver: true } };
export default handler;
