import { BadRequestError } from '@bike4mind/common';
import { validateAppUrl } from '@server/utils/validators';

export const MCP_OAUTH_CALLBACK_PATH = '/integrations/mcp-oauth-callback';
export const MCP_OAUTH_CLIENT_METADATA_PATH = '/.well-known/oauth-client/mcp-client.json';

function appOrigin(): string {
  const appUrl = validateAppUrl('MCP OAuth');
  if (!appUrl)
    throw new BadRequestError('This deployment has no valid APP_URL for sign-in', { code: 'app_url_missing' });
  return new URL(appUrl).origin;
}

/** One fixed redirect URI per deployment: it is what DCR registers and what the CIMD document lists. */
export const redirectUri = (): string => `${appOrigin()}${MCP_OAUTH_CALLBACK_PATH}`;

/** The CIMD `client_id`: the URL of the client metadata document this app serves. */
export const clientMetadataUrl = (): string => `${appOrigin()}${MCP_OAUTH_CLIENT_METADATA_PATH}`;
