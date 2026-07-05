/**
 * GET /api/oauth/jwks
 *
 * JWKS (JSON Web Key Set) endpoint. Mapped from /.well-known/jwks.json
 * via next.config.mjs rewrites. Used by Cognito and other OIDC clients
 * to verify RS256-signed ID tokens.
 */

import { baseApi } from '@server/middlewares/baseApi';
import { getJwks } from '@server/auth/oauthServer';

const handler = baseApi({ auth: false }).get((_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.json(getJwks());
});

export const config = { api: { externalResolver: true } };
export default handler;
