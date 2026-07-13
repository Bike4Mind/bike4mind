import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';

/**
 * Notion OAuth configuration
 *
 * Notion OAuth is simpler than Atlassian:
 * - Access tokens are long-lived and don't expire unless revoked
 * - No refresh tokens are issued
 * - Uses Basic authentication for token exchange (client_id:client_secret base64 encoded)
 *
 * @see https://developers.notion.com/docs/authorization
 */

interface NotionOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

/**
 * Reads Notion OAuth env values from admin settings.
 * Dynamically constructs the callback URL based on the current environment.
 */
export const getNotionOAuthConfig = async (): Promise<NotionOAuthConfig> => {
  // Remove trailing slash to prevent double-slash in redirect URI
  const baseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const redirectUri = `${baseUrl}/api/mcp-servers/notion/callback`;

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const clientId = getSettingsValue('notionClientId', settings);
  const clientSecret = getSettingsValue('notionClientSecret', settings);

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
};

/**
 * Notion API endpoints and version
 */
export const NOTION_OAUTH_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';
export const NOTION_OAUTH_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
export const NOTION_API_BASE_URL = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
