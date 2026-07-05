import { JiraApi } from '@bike4mind/common';
import type { JiraConfig } from '@bike4mind/common';
import { AtlassianTokenManager } from './atlassianTokenManager';

/**
 * Create an authenticated JiraApi client for the given user.
 *
 * Fetches valid Atlassian OAuth tokens (auto-refreshing if needed),
 * builds the JiraConfig, and returns a ready-to-use JiraApi instance.
 *
 * Returns null if the user has no Atlassian connection.
 */
export async function getJiraClient(userId: string): Promise<JiraApi | null> {
  const tokens = await AtlassianTokenManager.getValidTokens(userId);
  if (!tokens) return null;

  // The siteUrl from token manager may have /wiki suffix for Confluence.
  // Strip it to get the base Jira site URL.
  const baseSiteUrl = tokens.siteUrl.replace(/\/wiki$/, '');

  const config: JiraConfig = {
    accessToken: tokens.accessToken,
    cloudId: tokens.cloudId,
    siteUrl: baseSiteUrl,
    webBaseUrl: `${baseSiteUrl}/browse`,
    apiBaseUrl: `https://api.atlassian.com/ex/jira/${tokens.cloudId}/rest/api/3`,
    agileApiBaseUrl: `https://api.atlassian.com/ex/jira/${tokens.cloudId}/rest/agile/1.0`,
    authHeader: `Bearer ${tokens.accessToken}`,
  };

  return new JiraApi(config);
}
