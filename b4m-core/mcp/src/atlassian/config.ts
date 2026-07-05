/**
 * Atlassian MCP Server - Configuration
 *
 * Environment variable parsing and config management with lazy-loading.
 * Reinitializes when env vars change at runtime (MCP host can update them).
 */

import { getAtlassianConfig, getErrorMessage } from '@bike4mind/common';

let cachedConfig: ReturnType<typeof getAtlassianConfig> | null = null;
let envSignature: string | null = null;

export function getEnvSignature(): string {
  return JSON.stringify({
    accessToken: process.env.ATLASSIAN_ACCESS_TOKEN ?? '',
    cloudId: process.env.ATLASSIAN_CLOUD_ID ?? '',
    siteUrl: process.env.ATLASSIAN_SITE_URL ?? '',
  });
}

export function getConfig(): ReturnType<typeof getAtlassianConfig> {
  const signature = getEnvSignature();

  if (!cachedConfig || envSignature !== signature) {
    try {
      cachedConfig = getAtlassianConfig();
      envSignature = signature;
    } catch (error) {
      throw new Error(
        `Atlassian configuration error: ${getErrorMessage(error)}. Please ensure ATLASSIAN_ACCESS_TOKEN, ATLASSIAN_CLOUD_ID, and ATLASSIAN_SITE_URL are set.`
      );
    }
  }

  return cachedConfig;
}
