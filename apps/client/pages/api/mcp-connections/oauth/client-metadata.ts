/**
 * GET /api/mcp-connections/oauth/client-metadata
 *
 * The OAuth Client ID Metadata Document this app presents to authorization servers that accept a URL as
 * `client_id`. Mapped from /.well-known/oauth-client/mcp-client.json via next.config.mjs rewrites.
 */
import { baseApi } from '@server/middlewares/baseApi';
import { clientMetadataUrl, redirectUri } from '@server/mcpConnections/oauth/redirectUri';

const handler = baseApi({ auth: false }).get((_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.json({
    client_id: clientMetadataUrl(),
    client_name: 'Bike4Mind',
    redirect_uris: [redirectUri()],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

export const config = { api: { externalResolver: true } };
export default handler;
