// Atlassian unified configuration for OAuth-authenticated Jira and Confluence operations

import type { JiraConfig } from '../jira/api';
import type { ConfluenceConfig } from '../confluence/api';

export type AtlassianEnvKeys = {
  accessToken: string;
  cloudId: string;
  siteUrl: string;
};

export interface AtlassianConfig {
  jira: JiraConfig;
  confluence: ConfluenceConfig;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unknown error occurred';
}

function resolveEnvValue(key: string): string | undefined {
  const value = process.env[key];
  if (value && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Get unified Atlassian configuration for both Jira and Confluence
 * Uses ATLASSIAN_* environment variables
 */
export function getAtlassianConfig(): AtlassianConfig {
  const accessToken = resolveEnvValue('ATLASSIAN_ACCESS_TOKEN');
  const cloudId = resolveEnvValue('ATLASSIAN_CLOUD_ID');
  const siteUrl = resolveEnvValue('ATLASSIAN_SITE_URL');

  const missing: string[] = [];
  if (!accessToken) missing.push('ATLASSIAN_ACCESS_TOKEN');
  if (!cloudId) missing.push('ATLASSIAN_CLOUD_ID');
  if (!siteUrl) missing.push('ATLASSIAN_SITE_URL');

  if (missing.length) {
    console.error('[Atlassian Config] Missing required environment variables for Atlassian API:');
    missing.forEach(item => console.error(`   ${item}`));
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return buildAtlassianConfig({ accessToken: accessToken!, cloudId: cloudId!, siteUrl: siteUrl! });
}

/**
 * Build the unified Atlassian configuration from explicit credentials.
 * Used by getAtlassianConfig (env-based system credentials) and by org-scoped
 * connections (OrgJiraConnection) that store credentials in the database.
 */
export function buildAtlassianConfig({ accessToken, cloudId, siteUrl }: AtlassianEnvKeys): AtlassianConfig {
  // Ensure siteUrl doesn't end with slash
  const normalizedSiteUrl = siteUrl.replace(/\/$/, '');

  // Confluence configuration - use Atlassian Cloud API gateway
  const confluenceWebBaseUrl = normalizedSiteUrl.endsWith('/wiki') ? normalizedSiteUrl : `${normalizedSiteUrl}/wiki`;
  const confluenceApiBaseUrlV1 = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/rest/api`;
  const confluenceApiBaseUrlV2 = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2`;

  // Jira configuration - use Atlassian Cloud API gateway
  const jiraWebBaseUrl = normalizedSiteUrl.endsWith('/wiki')
    ? normalizedSiteUrl.replace(/\/wiki$/, '/jira')
    : `${normalizedSiteUrl}/jira`;
  const jiraApiBaseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  const jiraAgileApiBaseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0`;

  const authHeader = `Bearer ${accessToken}`;

  return {
    jira: {
      accessToken,
      cloudId,
      siteUrl: jiraWebBaseUrl,
      webBaseUrl: jiraWebBaseUrl,
      apiBaseUrl: jiraApiBaseUrl,
      agileApiBaseUrl: jiraAgileApiBaseUrl,
      authHeader,
    },
    confluence: {
      accessToken,
      cloudId,
      siteUrl: confluenceWebBaseUrl,
      webBaseUrl: confluenceWebBaseUrl,
      apiBaseUrlV1: confluenceApiBaseUrlV1,
      apiBaseUrlV2: confluenceApiBaseUrlV2,
      authHeader,
    },
  };
}
