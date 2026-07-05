import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';

/**
 * Atlassian OAuth scopes shared between the connect and token rotation flows.
 */
export const ATLASSIAN_OAUTH_SCOPES = [
  // Confluence permissions (granular)
  'read:page:confluence',
  'write:page:confluence',
  'read:space:confluence',
  'write:space:confluence',
  'delete:page:confluence',
  'read:comment:confluence',
  'write:comment:confluence',
  'read:attachment:confluence',
  'write:attachment:confluence',
  'delete:attachment:confluence',
  // Confluence permissions (classic)
  'search:confluence',
  'read:confluence-content.all',
  'read:confluence-user',
  'write:confluence-content',
  'write:confluence-file',
  // Jira permissions
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'manage:jira-project',
  'manage:jira-configuration',
  'manage:jira-webhook',
  // Jira Software (Agile) permissions
  'read:project:jira',
  'read:board-scope:jira-software',
  'read:board-scope.admin:jira-software',
  'write:board-scope:jira-software',
  'read:sprint:jira-software',
  'write:sprint:jira-software',
  'read:issue-details:jira',
  'read:jql:jira',
  // For refresh_tokens
  'offline_access',
].join(' ');

interface AtlassianOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

/**
 * Reads Atlassian OAuth env values from admin settings.
 * Dynamically constructs the callback URL based on the current environment.
 */
export const getAtlassianOAuthConfig = async (): Promise<AtlassianOAuthConfig> => {
  // Remove trailing slash to prevent double-slash in redirect URI (e.g., https://example.com//api/...)
  const baseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const redirectUri = `${baseUrl}/api/mcp-servers/atlassian/callback`;

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const clientId = getSettingsValue('atlassianClientId', settings);
  const clientSecret = getSettingsValue('atlassianClientSecret', settings);

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
};
