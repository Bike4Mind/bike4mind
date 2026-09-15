/**
 * GET /api/oauth/openid-configuration
 *
 * OIDC Discovery document. Mapped from /.well-known/openid-configuration
 * via next.config.mjs rewrites.
 */

import { baseApi } from '@server/middlewares/baseApi';
import { getOidcDiscovery } from '@server/auth/oauthServer';

const handler = baseApi({ auth: false }).get((_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.json(getOidcDiscovery());
});

export const config = { api: { externalResolver: true } };
export default handler;
